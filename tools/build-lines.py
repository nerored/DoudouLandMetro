#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-lines.py — 由 OSM 线路数据生成多线路版 data.js（成都地铁 1/2/3/4/5/6/7/8/9/10/13/17/18/19/27/30 + S3）

输入：
  /tmp/osm-lines/<line>.json     由 tools/fetch-osm-lines.py 抓取（站点 + 轨道几何）
  tools/build-data.py 里的 STATION_META  1/2 号线的人工核对元数据（车站形式/在建换乘等）
输出：../data.js（覆盖）

做法：
  * 每条线：把关系里的 way 按成员顺序首尾相接 → 抽稀 → 投影（1 km = 50 单位）
  * 站点按「中文站名」跨线去重：同名站合并成一条，lines 记录它经过的所有线路
  * 换乘 = 该站经过的其它线路（运行时结合当前线路算），并合并 1/2 号线的人工核对换乘信息
  * 里程 = OSM 轨道弧长（未等比缩放）
"""
import json
import math
import os
import sys
import importlib.util
from collections import OrderedDict

LAT0, LON0 = 30.58, 104.06
KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(LAT0))
UNITS_PER_KM = 50.0
MARGIN_UNITS = 200.0
TOL_TRACK = 3.0

SRC = '/tmp/osm-lines'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data.js')

# 线路显示名 / 颜色。颜色多数为公开资料近似值，未逐条官方核对 → 标 待核实
LINE_INFO = OrderedDict([
    ('1',  dict(name='成都地铁 1 号线',  color='#0d6cb5', verified=True)),
    ('2',  dict(name='成都地铁 2 号线',  color='#e8792a', verified=True)),
    ('3',  dict(name='成都地铁 3 号线',  color='#d5007f', verified=False)),
    ('4',  dict(name='成都地铁 4 号线',  color='#3cb371', verified=False)),
    ('5',  dict(name='成都地铁 5 号线',  color='#7b3f9e', verified=False)),
    ('6',  dict(name='成都地铁 6 号线',  color='#b5651d', verified=False)),
    ('7',  dict(name='成都地铁 7 号线',  color='#f2c200', verified=False)),
    ('8',  dict(name='成都地铁 8 号线',  color='#00a0a0', verified=False)),
    ('9',  dict(name='成都地铁 9 号线',  color='#e07b00', verified=False)),
    ('10', dict(name='成都地铁 10 号线', color='#0aa5a5', verified=False)),
    ('13', dict(name='成都地铁 13 号线', color='#8f5c2b', verified=False)),
    ('17', dict(name='成都地铁 17 号线', color='#2e8b57', verified=False)),
    ('18', dict(name='成都地铁 18 号线', color='#1c6fb8', verified=False)),
    ('19', dict(name='成都地铁 19 号线', color='#5b6fb5', verified=False)),
    ('27', dict(name='成都地铁 27 号线', color='#9b2d30', verified=False)),
    ('30', dict(name='成都地铁 30 号线', color='#6a4c93', verified=False)),
    ('S3', dict(name='市域铁路 S3 资阳线', color='#5f7d8c', verified=False)),
])
LOOP_LINES = {'7'}                     # 环线：到终点不回折返，直接绕回起点

# 线路顺序（图例/选择器里的顺序）；1 号线主线/支线是两个文件，但属于同一条线
LINE_ORDER = ['1main', '1branch'] + [k for k in LINE_INFO.keys() if k != '1']
SERVICE_LINE = {'1main': '1', '1branch': '1'}      # 交路文件 -> 线路 key


def line_key_of(k):
    return SERVICE_LINE.get(k, k)


# 站点投影用哪段轨道：优先选它真正经过的那个交路文件（支线站不要投到主线上去）
def track_file_for_station(nm, line_key, per_line_stops):
    for k in LINE_ORDER:
        if line_key_of(k) == line_key and nm in per_line_stops.get(k, []):
            return k
    return line_key


# ------------------------------------------------------------------ 几何工具
def project(lat, lon):
    return ((lon - LON0) * KM_PER_DEG_LON * UNITS_PER_KM,
            (LAT0 - lat) * KM_PER_DEG_LAT * UNITS_PER_KM)


def dist_m(a, b):
    dlat = (b[0] - a[0]) * KM_PER_DEG_LAT * 1000.0
    dlon = (b[1] - a[1]) * KM_PER_DEG_LON * 1000.0
    return math.hypot(dlat, dlon)


def rdp(points, tol_m):
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        ax, ay = points[i0][1], points[i0][0]
        bx, by = points[i1][1], points[i1][0]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best_i, best_d = -1, -1.0
        for i in range(i0 + 1, i1):
            px, py = points[i][1], points[i][0]
            d = math.hypot(px - ax, py - ay) if norm == 0 else abs(dy * px - dx * py + bx * ay - by * ax) / norm
            d_m = d * KM_PER_DEG_LAT * 1000.0
            if d_m > best_d:
                best_d, best_i = d_m, i
        if best_d > tol_m:
            keep[best_i] = True
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return [p for p, k in zip(points, keep) if k]


def stitch(ways):
    out = []
    for w in ways:
        pts = [(g['lat'], g['lon']) for g in w['geometry']]
        if len(pts) < 2:
            continue
        if not out:
            out = pts[:]
            continue
        if dist_m(out[-1], pts[0]) <= dist_m(out[-1], pts[-1]):
            out.extend(pts[1:])
        else:
            out.extend(reversed(pts[:-1]))
    return out


def poly_len_km(pts):
    return sum(dist_m(pts[i - 1], pts[i]) for i in range(1, len(pts))) / 1000.0


def nearest_on_polyline(xy, p):
    best = (0.0, float('inf'))
    acc = 0.0
    for i in range(1, len(xy)):
        ax, ay = xy[i - 1]
        bx, by = xy[i]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / seg2))
        fx, fy = ax + t * dx, ay + t * dy
        d = math.hypot(p[0] - fx, p[1] - fy)
        if d < best[1]:
            best = (acc + t * math.sqrt(seg2), d)
        acc += math.sqrt(seg2)
    return best


def load_legacy_meta():
    """复用 1/2 号线人工核对的站点元数据（车站形式、在建换乘等）"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build-data.py')
    try:
        spec = importlib.util.spec_from_file_location('bd', path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        print('   复用 build-data.py 的 STATION_META：%d 站' % len(m.STATION_META))
        return m.STATION_META
    except Exception as e:
        print('   ! 无法加载人工元数据（忽略）：%s' % e, file=sys.stderr)
        return {}


def main():
    legacy = load_legacy_meta()
    lines_raw = OrderedDict()
    for k in LINE_ORDER:
        p = os.path.join(SRC, '%s.json' % k)
        if not os.path.exists(p):
            print('   ! 缺少 %s，跳过该线路' % p, file=sys.stderr)
            continue
        d = json.load(open(p, encoding='utf-8'))
        if not d.get('stops') or not d.get('ways'):
            print('   ! %s 数据为空，跳过' % k, file=sys.stderr)
            continue
        lines_raw[k] = d

    # ---- 轨道 ----
    tracks = OrderedDict()          # service key -> {pts(投影), km}
    svc_defs = []                   # 交路定义
    for k, d in lines_raw.items():
        pts = stitch(d['ways'])
        if len(pts) < 2:
            print('   ! %s 轨道拼接失败' % k, file=sys.stderr)
            continue
        km = poly_len_km(pts)
        simpl = rdp(pts, TOL_TRACK)
        if k == '1' and len(d['rels']) == 2:
            # 1 号线两个关系：主线 / 支线，分开处理（用同一个 stitched 结果拆不干净，改按站点序列分）
            pass
        tracks[k] = {'pts': simpl, 'km': km, 'stations': []}
        print('   %-4s 轨道 %4d→%-4d 点  %6.2f km' % (k, len(pts), len(simpl), km))

    # ---- 站点（跨线按站名去重）----
    stations = OrderedDict()        # 站名 -> 记录
    per_line_stops = OrderedDict()
    for k, d in lines_raw.items():
        if k not in tracks:
            continue
        seq = []
        for s in d['stops']:
            nm = (s['name'] or '').replace('站', '') if s['name'].endswith('站') and len(s['name']) > 2 else s['name']
            nm = s['name']
            if not nm:
                continue
            if seq and seq[-1] == nm:
                continue                      # 上下行重复
            seq.append(nm)
            if nm not in stations:
                stations[nm] = {
                    'zh': nm,
                    'en': s.get('name_en', ''),
                    'lat': s['lat'], 'lon': s['lon'],
                    'lines': [line_key_of(k)],
                }
            elif line_key_of(k) not in stations[nm]['lines']:
                stations[nm]['lines'].append(line_key_of(k))
        per_line_stops[k] = seq
        print('   %-4s 站点 %d 个' % (k, len(seq)))

    # ---- 投影 + 站点在轨道上的弧长/里程 ----
    xs, ys = [], []
    for k, t in tracks.items():
        t['xy'] = [project(la, lo) for (la, lo) in t['pts']]
        for x, y in t['xy']:
            xs.append(x); ys.append(y)
    off_x = -min(xs) + MARGIN_UNITS
    off_y = -min(ys) + MARGIN_UNITS

    def shift(xy):
        return [(round(x + off_x, 1), round(y + off_y, 1)) for x, y in xy]

    def shift_pt(p):
        return (round(p[0] + off_x, 1), round(p[1] + off_y, 1))

    st_out = []
    for nm, st in stations.items():
        line0 = st['lines'][0]
        t = tracks[track_file_for_station(nm, line0, per_line_stops)]
        pos = shift_pt(project(st['lat'], st['lon']))
        s, d = nearest_on_polyline(shift(t['xy']), pos)
        legacy_meta = legacy.get(nm, {})
        rec = OrderedDict()
        rec['id'] = legacy_meta.get('id') or ('s' + str(len(st_out) + 1))
        rec['zh'] = nm
        rec['en'] = st['en'] or legacy_meta.get('en', '')
        rec['x'] = pos[0]
        rec['y'] = pos[1]
        rec['lat'] = round(st['lat'], 5)
        rec['lon'] = round(st['lon'], 5)
        rec['lines'] = st['lines']
        # 换乘：该站经过的其它线路 + 人工标注的（可能是其它在建线路）
        tr = [k for k in st['lines'] if k != line0]
        for extra in legacy_meta.get('tr', []):
            if extra not in st['lines'] and extra not in tr:
                tr.append(extra)
        if tr:
            rec['tr'] = tr
        if legacy_meta.get('form'):
            rec['form'] = legacy_meta['form']
        if legacy_meta.get('status'):
            rec['status'] = legacy_meta['status']
        if legacy_meta.get('no_stop'):
            rec['noStop'] = True
        if legacy_meta.get('planned'):
            rec['planned'] = legacy_meta['planned']
        st_out.append(rec)

    print('   合计站点 %d 个（跨线去重后）' % len(st_out))

    # ---- 输出 JS ----
    def js_pts(pts):
        return '[' + ','.join('[%g,%g]' % (x, y) for x, y in pts) + ']'

    lines_js = []
    for k in LINE_ORDER:
        if k not in tracks:
            continue
        info = LINE_INFO[line_key_of(k)]
        stops = per_line_stops.get(k, [])
        ids = []
        for nm in stops:
            for r in st_out:
                if r['zh'] == nm:
                    ids.append(r['id'])
                    break
        svc = ('{key:"%s",label:"%s",stationIds:[%s],tracks:["%s"%s]}'
               % (k, (stops[0] if stops else '') + ' ↔ ' + (stops[-1] if stops else ''),
                  ','.join('"%s"' % i for i in ids), k,
                  ',loop:true' if k in LOOP_LINES else ''))
        lines_js.append('{key:"%s",name:"%s",short:"%s",color:"%s",services:[%s]}'
                        % (line_key_of(k), info['name'], k, info['color'], svc))

    # 把属于同一线路的多个交路合并进同一个 line（例如 1main + 1branch 合成 1 号线）
    merged = OrderedDict()
    for js in lines_js:
        import re as _re
        key = _re.search(r'\{key:"([^"]+)"', js).group(1)
        if key in merged:
            merged[key] = merged[key][:-2] + ',' + js.split('services:[', 1)[1]
        else:
            merged[key] = js
    lines_js = list(merged.values())

    st_js = []
    for r in st_out:
        st_js.append('{' + ','.join(
            '%s:%s' % (k2, json.dumps(v, ensure_ascii=False) if not isinstance(v, bool) else ('true' if v else 'false'))
            for k2, v in r.items()) + '}')

    out = []
    out.append('/* =============================================================================')
    out.append(' * data.js — 成都地铁示意线路图数据（多线路版，由 tools/build-lines.py 生成，勿手改）')
    out.append(' * 数据来源：OpenStreetMap 线路关系（© OpenStreetMap contributors, ODbL 1.0）')
    out.append(' *   站点与轨道几何：relation 的 full 接口抓取，抓取日期 2026-09-12')
    out.append(' *   1/2 号线的车站形式、在建换乘等人工核对信息来自百度百科词条')
    out.append(' * 线路颜色：除 1/2 号线外多为公开资料近似值，未逐条官方核对（标 待核实）')
    out.append(' * 坐标系：局部等距圆柱投影（lat0=%.2f），1 km = %.0f 单位；里程 = OSM 轨道弧长' % (LAT0, UNITS_PER_KM))
    out.append(' * ========================================================================== */')
    out.append('window.METRO = (function () {')
    out.append("  'use strict';")
    out.append('  var lines = [' + ','.join(lines_js) + '];')
    out.append('  var stations = [' + ','.join(st_js) + '];')
    out.append('  var tracks = {};')
    for k, t in tracks.items():
        out.append('  tracks["%s"] = %s;' % (k, js_pts(shift(t['xy']))))
    # 底图：读 tools/basemap.json（中心城区水系/道路，来自 OSM）
    water = {'rivers': [], 'lakes': []}
    roads = []
    try:
        bp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'basemap.json')
        b = json.load(open(bp, encoding='utf-8'))
        water = b.get('water', water)
        roads = b.get('roads', roads)
        print('   底图：%d 河 / %d 湖 / %d 段道路' % (len(water.get('rivers', [])), len(water.get('lakes', [])), len(roads)))
    except Exception as e:
        print('   ! 底图读取失败：%s' % e, file=sys.stderr)

    out.append('  var water = %s;' % (json.dumps(water, ensure_ascii=False, separators=(',', ':'))))
    out.append('  var roads = %s;' % (json.dumps(roads, ensure_ascii=False, separators=(',', ':'))))
    out.append('  var byId = {}; var kmById = {};')
    out.append('  stations.forEach(function (s) { byId[s.id] = s; });')
    out.append('  var svc = {};')
    out.append('  lines.forEach(function (l) { l.services.forEach(function (s) { s.lineKey = l.key; s.color = l.color; svc[s.key] = s; }); });')
    out.append('  return {')
    out.append('    generated: "by tools/build-lines.py, 2026-09-12 (OSM 线路关系)",')
    out.append('    unitsPerKm: %g, lines: lines, stations: stations, byId: byId, services: svc,' % UNITS_PER_KM)
    out.append('    tracks: tracks, water: water, roads: roads,')
    out.append('    mapBox: {x0:%g,y0:%g,x1:%g,y1:%g},' % (
        MARGIN_UNITS, MARGIN_UNITS, max(xs) + off_x - MARGIN_UNITS, max(ys) + off_y - MARGIN_UNITS))
    out.append('    lineColors: %s' % json.dumps({k: v['color'] for k, v in LINE_INFO.items()}))
    out.append('  };')
    out.append('})();')
    out.append('')
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    size = len('\n'.join(out).encode('utf-8'))
    print('== 输出 %s（%.1f KB）：%d 条线路 / %d 站 / %d 段轨道'
          % (OUT, size / 1024.0, len(lines_js), len(st_out), len(tracks)))


if __name__ == '__main__':
    main()
