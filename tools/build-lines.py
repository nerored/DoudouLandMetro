#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-lines.py — 生成多线路版 data.js（成都地铁 1/2/3/4/5/6/7/8/9/10/13/17/18/19/27/30 + S3）

输入
  /tmp/osm-lines/<service>.json   由 tools/fetch-osm-lines.py 抓取（站点顺序 + 轨道几何）
  tools/basemap.json              水系/湖泊/道路（中心城区，来自 OSM）
  tools/build-data.py 的 STATION_META   1/2 号线人工核对的车站形式/在建换乘等
输出
  ../data.js   整份内容是一个纯 JSON 负载（JSON 是 JS 子集 ⇒ 语法必然合法）

约定
  * 每个 "service"（交路）对应一个抓取文件：1 号线有 1main / 1branch，其余线路与线路同 key
  * 站点按中文站名跨线去重；lines 记录它经过的线路，换乘关系由此推导（再并入人工标注）
  * 里程不写进数据：应用侧按轨道弧长现算（km = 弧长 / unitsPerKm）
"""

import importlib.util
import json
import math
import os
import sys
from collections import OrderedDict

LAT0, LON0 = 30.58, 104.06
KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(LAT0))
UNITS_PER_KM = 50.0
MARGIN_UNITS = 200.0
TOL_TRACK = 3.0
SRC = '/tmp/osm-lines'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'data.js')

# 线路元数据：色号来源见 memory/reference/chengdu-metro-line-colors.md（官网线网图取样 + 维基 Module:Adjacent stations）
LINE_INFO = OrderedDict([
    ('1',  ('成都地铁 1 号线',  '#0F0F96', True)),
    ('2',  ('成都地铁 2 号线',  '#FE633D', True)),
    ('3',  ('成都地铁 3 号线',  '#D60F6B', True)),
    ('4',  ('成都地铁 4 号线',  '#1CAD64', True)),
    ('5',  ('成都地铁 5 号线',  '#A03F92', True)),
    ('6',  ('成都地铁 6 号线',  '#BE7331', True)),
    ('7',  ('成都地铁 7 号线',  '#65D0DE', True)),
    ('8',  ('成都地铁 8 号线',  '#A6C215', False)),
    ('9',  ('成都地铁 9 号线',  '#F1AD17', True)),
    ('10', ('成都地铁 10 号线', '#0054BB', True)),
    ('13', ('成都地铁 13 号线', '#B2A225', False)),
    ('17', ('成都地铁 17 号线', '#87E0AA', True)),
    ('18', ('成都地铁 18 号线', '#1A686E', True)),
    ('19', ('成都地铁 19 号线', '#94A2DC', True)),
    ('27', ('成都地铁 27 号线', '#00A4E0', True)),
    ('30', ('成都地铁 30 号线', '#E3718F', False)),
    ('S3', ('市域铁路 S3 资阳线', '#858686', False)),
])
# 交路 -> 线路 key（1 号线两个交路）
SERVICE_LINE = {'1main': '1', '1branch': '1'}
ORDER = ['1main', '1branch'] + [k for k in LINE_INFO if k != '1']
LOOP_LINES = {'7'}                       # 环线：到终点绕回起点，不折返
KIND = {'S3': '市域铁路'}                 # 非地铁线路的标注


def line_key_of(svc):
    return SERVICE_LINE.get(svc, svc)


# ------------------------------------------------------------------ 几何
def project(lat, lon):
    return ((lon - LON0) * KM_PER_DEG_LON * UNITS_PER_KM,
            (LAT0 - lat) * KM_PER_DEG_LAT * UNITS_PER_KM)


def dist_m(a, b):
    return math.hypot((b[0] - a[0]) * KM_PER_DEG_LAT * 1000.0,
                      (b[1] - a[1]) * KM_PER_DEG_LON * 1000.0)


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
        bi, bd = -1, -1.0
        for i in range(i0 + 1, i1):
            px, py = points[i][1], points[i][0]
            d = math.hypot(px - ax, py - ay) if norm == 0 else abs(dy * px - dx * py + bx * ay - by * ax) / norm
            dm = d * KM_PER_DEG_LAT * 1000.0
            if dm > bd:
                bd, bi = dm, i
        if bd > tol_m:
            keep[bi] = True
            stack.append((i0, bi))
            stack.append((bi, i1))
    return [p for p, k in zip(points, keep) if k]


def stitch(ways):
    """把关系的 way 拼成一条链。
    注意：OSM 路由关系里 way 的成员**顺序不可靠**（实测 1 号线按成员顺序拼出 59 km，真实 37 km），
    所以用「两头最近端点贪心链接」：每次拿端点离链首/链尾最近的未用段接上去，必要时反向。"""
    segs = []
    for w in ways:
        pts = [(g['lat'], g['lon']) for g in w['geometry']]
        if len(pts) >= 2:
            segs.append(pts)
    if not segs:
        return []

    def seg_len(s):
        return sum(dist_m(s[i - 1], s[i]) for i in range(1, len(s)))

    segs.sort(key=seg_len, reverse=True)          # 从最长的一段开始
    chain = segs.pop(0)
    gaps = []
    while segs:
        bi, brev, battach_head, bd = -1, False, False, float('inf')
        for i, s in enumerate(segs):
            d_tail0, d_tail1 = dist_m(chain[-1], s[0]), dist_m(chain[-1], s[-1])
            d_head0, d_head1 = dist_m(chain[0], s[-1]), dist_m(chain[0], s[0])
            if d_tail0 < bd:
                bd, bi, brev, battach_head = d_tail0, i, False, False
            if d_tail1 < bd:
                bd, bi, brev, battach_head = d_tail1, i, True, False
            if d_head0 < bd:
                bd, bi, brev, battach_head = d_head0, i, False, True
            if d_head1 < bd:
                bd, bi, brev, battach_head = d_head1, i, True, True
        if bi < 0 or bd > 2000:                    # 接不上了（缺口 >2 km）：不再硬凑
            gaps.append(bd)
            break
        s = segs.pop(bi)
        if brev:
            s = list(reversed(s))
        if battach_head:
            chain = s[:-1] + chain
        else:
            chain = chain + s[1:]
    return chain


def poly_len_km(pts):
    return sum(dist_m(pts[i - 1], pts[i]) for i in range(1, len(pts))) / 1000.0


def nearest_on_polyline(xy, p):
    best_s, best_d = 0.0, float('inf')
    acc = 0.0
    for i in range(1, len(xy)):
        ax, ay = xy[i - 1]
        bx, by = xy[i]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / seg2))
        fx, fy = ax + t * dx, ay + t * dy
        d = math.hypot(p[0] - fx, p[1] - fy)
        if d < best_d:
            best_s, best_d = acc + t * math.sqrt(seg2), d
        acc += math.sqrt(seg2)
    return best_s, best_d


def legacy_meta():
    path = os.path.join(HERE, 'build-data.py')
    try:
        spec = importlib.util.spec_from_file_location('bd_legacy', path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m.STATION_META
    except Exception as e:
        print('  ! 人工元数据加载失败（忽略）：%s' % e, file=sys.stderr)
        return {}


def main():
    only = None
    if len(sys.argv) > 2 and sys.argv[1] == '--lines':
        only = set(sys.argv[2].split(','))
    legacy = legacy_meta()
    print('   人工元数据（1/2 号线）：%d 站' % len(legacy))

    raw = OrderedDict()
    for svc in ORDER:
        if only is not None and line_key_of(svc) not in only:
            continue
        p = os.path.join(SRC, '%s.json' % svc)
        if not os.path.exists(p):
            print('  ! 缺 %s，跳过' % svc, file=sys.stderr)
            continue
        d = json.load(open(p, encoding='utf-8'))
        if not d.get('stops') or not d.get('ways'):
            print('  ! %s 数据为空，跳过' % svc, file=sys.stderr)
            continue
        raw[svc] = d

    # ---- 轨道 ----
    tracks = OrderedDict()          # svc -> {pts(经纬度), xy(投影), km}
    for svc, d in raw.items():
        pts = stitch(d['ways'])
        if len(pts) < 2:
            print('  ! %s 轨道拼接失败' % svc, file=sys.stderr)
            continue
        # 方向校正：链路必须从本交路的首发站开始（贪心拼接的起点可能在中间）
        first = None
        for s in d['stops']:
            if s.get('name') and first is None:
                first = (s['lat'], s['lon'])
        if first is not None and dist_m(pts[0], first) > dist_m(pts[-1], first):
            pts.reverse()
        km = poly_len_km(pts)
        simpl = rdp(pts, TOL_TRACK)
        tracks[svc] = {'pts': simpl, 'km': km}
        # 合理性校验：轨道长度 ÷ 站间直线距离之和（真实线路约 1.0~1.4，拼接错乱会明显偏大）
        seq0 = [s['name'] for s in d['stops'] if s.get('name')]
        coord = {}
        for s in d['stops']:
            if s.get('name') and s['name'] not in coord:
                coord[s['name']] = (s['lat'], s['lon'])
        direct = sum(dist_m(coord[seq0[i - 1]], coord[seq0[i]]) for i in range(1, len(seq0))
                     if seq0[i - 1] in coord and seq0[i] in coord) / 1000.0
        ratio = (km / direct) if direct > 0.5 else 0
        flag = '' if (ratio == 0 or 1.0 <= ratio <= 1.5) else '  <== 可疑！'
        print('   %-8s 轨道 %4d→%-4d 点  %6.2f km  (直线 %.1f km, 比 %.2f)%s'
              % (svc, len(pts), len(simpl), km, direct, ratio, flag))

    # ---- 站点（按中文站名去重）----
    stations = OrderedDict()
    stops_of = OrderedDict()
    for svc, d in raw.items():
        if svc not in tracks:
            continue
        seq = []
        for s in d['stops']:
            nm = (s.get('name') or '').strip()
            if not nm:
                continue
            if seq and seq[-1] == nm:
                continue
            seq.append(nm)
            if nm not in stations:
                stations[nm] = {'zh': nm, 'en': s.get('name_en', ''), 'lat': s['lat'], 'lon': s['lon'],
                                'lines': [line_key_of(svc)]}
            elif line_key_of(svc) not in stations[nm]['lines']:
                stations[nm]['lines'].append(line_key_of(svc))
        stops_of[svc] = seq
        print('   %-8s 站点 %3d 个' % (svc, len(seq)))
    print('   合计去重后 %d 站' % len(stations))

    # ---- 投影 + 平移 ----
    allx, ally = [], []
    for svc, t in tracks.items():
        t['xy'] = [project(la, lo) for (la, lo) in t['pts']]
        for x, y in t['xy']:
            allx.append(x); ally.append(y)
    off_x = -min(allx) + MARGIN_UNITS
    off_y = -min(ally) + MARGIN_UNITS

    def shift_xy(xy):
        return [[round(x + off_x, 1), round(y + off_y, 1)] for x, y in xy]

    def shift_pt(p):
        return [round(p[0] + off_x, 1), round(p[1] + off_y, 1)]

    # 站点投影到「它真正经过的那个交路」的轨道上    def track_for(nm, line_key):
        for svc in ORDER:
            if line_key_of(svc) == line_key and nm in stops_of.get(svc, []) and svc in tracks:
                return svc
        return None

    # 站点投影到「它真正经过的那个交路」的轨道上（支线站不要投到主线上去）
    def track_for(nm, line_key):
        for svc in ORDER:
            if line_key_of(svc) == line_key and nm in stops_of.get(svc, []) and svc in tracks:
                return svc
        return None

    st_out = []
    for nm, st in stations.items():
        lk = st['lines'][0]
        svc = track_for(nm, lk) or (lk if lk in tracks else None)
        pos = shift_pt(project(st['lat'], st['lon']))
        lm = legacy.get(nm, {})
        rec = OrderedDict()
        rec['id'] = lm.get('id') or ('s%03d' % (len(st_out) + 1))
        rec['zh'] = nm
        rec['en'] = st['en'] or lm.get('en', '')
        rec['x'] = pos[0]
        rec['y'] = pos[1]
        rec['lat'] = round(st['lat'], 5)
        rec['lon'] = round(st['lon'], 5)
        rec['lines'] = st['lines']
        tr = [k for k in st['lines'] if k != lk]
        for extra in lm.get('tr', []):
            if extra not in st['lines'] and extra not in tr:
                tr.append(extra)
        rec['tr'] = tr          # 总是写（可能为空数组），应用侧直接 tr.length 不会挂
        for k in ('form', 'status'):
            if lm.get(k):
                rec[k] = lm[k]
        if lm.get('no_stop'):
            rec['noStop'] = True
        if lm.get('planned'):
            rec['planned'] = lm['planned']
        if svc and svc in tracks:
            s_, d_ = nearest_on_polyline(shift_xy(tracks[svc]['xy']), pos)
            rec['projErr'] = round(d_, 2)
        st_out.append(rec)

    # ---- 线路 / 交路 ----
    lines_out = OrderedDict()
    for svc in ORDER:
        if svc not in tracks:
            continue
        lk = line_key_of(svc)
        name, color, verified = LINE_INFO[lk]
        entry = lines_out.setdefault(lk, OrderedDict([
            ('key', lk), ('name', name),
            ('short', (lk + '号线') if lk.isdigit() else lk),
            ('color', color), ('colorVerified', verified),
            ('services', []),
        ]))
        if lk in KIND:
            entry['kind'] = KIND[lk]
        seq = stops_of.get(svc, [])
        ids = []
        for nm in seq:
            for r in st_out:
                if r['zh'] == nm:
                    ids.append(r['id'])
                    break
        sdef = OrderedDict([
            ('key', svc),
            ('label', (seq[0] if seq else '') + ' ↔ ' + (seq[-1] if seq else '')),
            ('stationIds', ids), ('tracks', [svc]),
        ])
        if lk in LOOP_LINES:
            sdef['loop'] = True
        entry['services'].append(sdef)

    # ---- 底图 ----
    water, roads = {'rivers': [], 'lakes': []}, []
    try:
        b = json.load(open(os.path.join(HERE, 'basemap.json'), encoding='utf-8'))
        water, roads = b.get('water', water), b.get('roads', roads)
    except Exception as e:
        print('  ! 底图读取失败：%s' % e, file=sys.stderr)

    services = {}
    for l in lines_out.values():
        for sv in l['services']:
            sv = dict(sv)
            sv['lineKey'] = l['key']
            sv['color'] = l['color']
            services[sv['key']] = sv

    payload = OrderedDict([
        ('generated', 'tools/build-lines.py · 2026-09-12 · OpenStreetMap 线路关系 + 百度百科人工核对'),
        ('unitsPerKm', UNITS_PER_KM),
        ('lines', list(lines_out.values())),
        ('services', services),
        ('stations', st_out),
        ('byId', {r['id']: r for r in st_out}),
        ('tracks', {svc: shift_xy(t['xy']) for svc, t in tracks.items()}),
        ('water', water),
        ('roads', roads),
        ('mapBox', {'x0': MARGIN_UNITS, 'y0': MARGIN_UNITS,
                    'x1': round(max(allx) + off_x - MARGIN_UNITS, 1),
                    'y1': round(max(ally) + off_y - MARGIN_UNITS, 1)}),
        ('lineColors', {k: v[1] for k, v in LINE_INFO.items()}),
        ('credits', '© OpenStreetMap contributors (ODbL 1.0)'),
    ])

    header = ('/* data.js — 成都地铁示意线路图数据（多线路版，由 tools/build-lines.py 生成，勿手改）\n'
              ' * 站点与轨道：OpenStreetMap 线路关系（© OpenStreetMap contributors, ODbL 1.0）；\n'
              ' * 1/2 号线车站形式、在建换乘等人工核对信息来自百度百科词条；\n'
              ' * 线路颜色：官网线网图取样 + 维基 Module:Adjacent stations（8/13/30 号线图上图例与描边不一致，取图例值）；\n'
              ' * 坐标系：局部等距圆柱投影（lat0=%.2f），1 km = %.0f 单位；里程 = 轨道弧长 */\n' % (LAT0, UNITS_PER_KM))
    text = header + 'window.METRO = ' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n'
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(text)
    print('== 输出 %s（%.1f KB）：%d 线路 / %d 交路 / %d 站 / %d 段轨道 / 底图 %d 河 %d 湖 %d 道路'
          % (OUT, len(text.encode('utf-8')) / 1024.0, len(lines_out), len(services), len(st_out),
             len(tracks), len(water.get('rivers', [])), len(water.get('lakes', [])), len(roads)))
    bad = [r for r in st_out if r.get('projErr', 0) > 60]
    if bad:
        print('   ! 投影误差 >60 单位的站点 %d 个（前 5）：%s'
              % (len(bad), ', '.join('%s %.0f' % (r['zh'], r['projErr']) for r in bad[:5])), file=sys.stderr)


if __name__ == '__main__':
    main()
