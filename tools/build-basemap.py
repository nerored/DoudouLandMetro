#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-basemap.py — 把 /tmp/basemap-raw/*.json（tools/fetch-basemap.py 抓的原始 OSM）合并、
                   去重、抽稀成 tools/basemap.json（应用侧 data.js 直接嵌入的底图）。

为什么要有这一步：
  * 原始数据是**整块 87 km × 94 km** 的经纬度 + 全部标签，直接进 data.js 会有几十 MB；
    底图只是装饰，必须抽稀到几百 KB 以内，同时保证“线路附近看得清、远端不空”。
  * 底图的坐标系必须和轨道**完全一致**：同一套等距圆柱投影 + 同一个平移量。
    平移量取决于全部轨道的包围盒，所以从 tools/basemap-shift.json 读
    （由 `python3 tools/build-lines.py --write-shift tools/basemap-shift.json` 生成）。

抽稀策略（相对旧版的变化：旧版整城一起抽稀，点一多就退化成“只留 motorway”）
  * 水系：只保留**有名字**的（与旧版一致），河流 river/canal/stream 用 12 m、湖泊轮廓 8 m；
    同名只留最长的一段（示意底图不需要画同一条河的多段分叉）。
  * 道路：分两档——
      A 档（距任一轨道 < NEAR_KM km）：motorway/trunk/primary，容差 34 m（线路附近是“主视野”，保留细节）；
      B 档（更远）：只留 motorway/trunk，容差 60 m（远端只做骨架，避免为看不见的毛细路买单）。

用法:
  python3 tools/build-basemap.py --report            # 只打印统计（体积/点数），不写文件
  python3 tools/build-basemap.py                     # 写 tools/basemap.json
  python3 tools/build-basemap.py --near-km 2 --out /tmp/bm.json
"""
import json
import math
import os
import sys
from collections import OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = '/tmp/basemap-raw'
SHIFT = os.path.join(HERE, 'basemap-shift.json')
OUT = os.path.join(HERE, 'basemap.json')

KM_PER_DEG_LAT = 110.574
LON0 = 104.06
NEAR_KM = 3.0          # A 档（线路附近）半径
TOL_NEAR = 45.0        # m（道路，线路附近；34 m 时点太多，底图是装饰）
TOL_FAR = 90.0         # m（道路，远端只做骨架）
TOL_WATER = 20.0       # m（水系；河道的弯折在整网尺度下看不到这么细）
TOL_LAKE = 12.0        # m（湖泊轮廓）
LAKE_MIN_KM2 = 0.05    # 小于这个面积（km²）的湖/水库/池塘不画（城郊密密麻麻的小水塘没意义）
ROAD_MIN_KM = 0.06     # 短于这个长度（km）的道路段不画：60 m 在整网视图下不到 1 px，纯属噪声
CLIP_MARGIN = 300.0    # 地图单位（≈6 km）：完全落在轨道包围盒 + 这个边距之外的元素不写进底图
                       # （平移被限制在轨道范围 +6%，再远的数据永远画不到，白占体积）


def km_per_deg_lon(lat0):
    return 111.320 * math.cos(math.radians(lat0))


def dist_m(a, b, klon):
    return math.hypot((b[0] - a[0]) * KM_PER_DEG_LAT * 1000.0, (b[1] - a[1]) * klon * 1000.0)


def rdp(points, tol_m, klon):
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


def poly_len_km(pts, klon):
    return sum(dist_m(pts[i - 1], pts[i], klon) for i in range(1, len(pts))) / 1000.0


def load_raw(kind):
    """把分块结果按 (type,id) 去重合并（分块之间有 0.012° 重叠，边界 way 会重复出现）。"""
    out = OrderedDict()
    n_file = 0
    for fn in sorted(os.listdir(RAW)):
        if not fn.startswith(kind + '-') or not fn.endswith('.json'):
            continue
        n_file += 1
        try:
            d = json.load(open(os.path.join(RAW, fn), encoding='utf-8'))
        except Exception as e:
            print('  ! 跳过 %s：%s' % (fn, e), file=sys.stderr)
            continue
        for e in d.get('elements', []):
            out[(e['type'], e['id'])] = e
    return out, n_file


def stitch_members(el, klon):
    """relation -> 折线（取最长的一段链，示意底图够用）"""
    parts = []
    for m in el.get('members', []):
        g = m.get('geometry') or []
        pts = [(p['lat'], p['lon']) for p in g]
        if len(pts) > 1:
            parts.append(pts)
    if not parts:
        return []
    return max(parts, key=lambda p: poly_len_km(p, klon))


def main():
    report = '--report' in sys.argv
    out_path = OUT
    if '--out' in sys.argv:
        out_path = sys.argv[sys.argv.index('--out') + 1]
    near_km = NEAR_KM
    if '--near-km' in sys.argv:
        near_km = float(sys.argv[sys.argv.index('--near-km') + 1])
    tol_near = TOL_NEAR
    if '--tol-near' in sys.argv:
        tol_near = float(sys.argv[sys.argv.index('--tol-near') + 1])
    tol_far = TOL_FAR
    if '--tol-far' in sys.argv:
        tol_far = float(sys.argv[sys.argv.index('--tol-far') + 1])
    tol_water = TOL_WATER
    if '--tol-water' in sys.argv:
        tol_water = float(sys.argv[sys.argv.index('--tol-water') + 1])
    lake_min = LAKE_MIN_KM2
    if '--lake-min-km2' in sys.argv:
        lake_min = float(sys.argv[sys.argv.index('--lake-min-km2') + 1])
    road_min = ROAD_MIN_KM
    if '--min-road-km' in sys.argv:
        road_min = float(sys.argv[sys.argv.index('--min-road-km') + 1])

    shift = json.load(open(SHIFT, encoding='utf-8'))
    LAT0, LON0_ = shift['lat0'], shift['lon0']
    upk, off_x, off_y = shift['unitsPerKm'], shift['offX'], shift['offY']
    klon = km_per_deg_lon(LAT0)

    def project(lat, lon):
        return ((lon - LON0_) * klon * upk, (LAT0 - lat) * KM_PER_DEG_LAT * upk)

    def shift_xy(pts):
        return [[round(x + off_x, 1), round(y + off_y, 1)]
                for x, y in (project(la, lo) for la, lo in pts)]

    water_el, n_wf = load_raw('water')
    road_el, n_rf = load_raw('roads')
    print('== 原始：water %d 个文件 / %d 个元素；roads %d 个文件 / %d 个元素'
          % (n_wf, len(water_el), n_rf, len(road_el)))

    # ---- 可视范围裁剪 ----
    clip = {'x0': shift['tracks']['xMin'] + off_x - CLIP_MARGIN,
            'y0': shift['tracks']['yMin'] + off_y - CLIP_MARGIN,
            'x1': shift['tracks']['xMax'] + off_x + CLIP_MARGIN,
            'y1': shift['tracks']['yMax'] + off_y + CLIP_MARGIN}

    def inside(pts):
        """元素包围盒与可视裁剪框有交集？
        先判经纬度投影后的 x/y（用未平移坐标比较，等价于平移后比较）。"""
        xs = [(lo - LON0_) * klon * upk for _, lo in pts]
        ys = [(LAT0 - la) * KM_PER_DEG_LAT * upk for la, _ in pts]
        return (max(xs) + off_x > clip['x0'] and min(xs) + off_x < clip['x1'] and
                max(ys) + off_y > clip['y0'] and min(ys) + off_y < clip['y1'])

    # ---- 轨道折线（用于“线路附近”判定）----
    track_pts = []
    osm_dir = '/tmp/osm-lines'
    if os.path.isdir(osm_dir):
        for fn in os.listdir(osm_dir):
            try:
                d = json.load(open(os.path.join(osm_dir, fn), encoding='utf-8'))
            except Exception:
                continue
            for w in d.get('ways', []):
                for g in w.get('geometry', []):
                    track_pts.append((g['lat'], g['lon']))
    # 2 km 网格索引，避免每段道路都去和几万个轨道点比距离
    CELL = 0.02
    grid = defaultdict(list)
    for p in track_pts:
        grid[(int(p[0] / CELL), int(p[1] / CELL))].append(p)

    def near_track(pts, km):
        """折线任一点距任一轨道点 < km？"""
        r = km / 110.574
        kc = int(math.ceil(km / (CELL * 110.574)))
        for la, lo in pts:
            ci, cj = int(la / CELL), int(lo / CELL)
            for i in range(ci - kc, ci + kc + 1):
                for j in range(cj - kc, cj + kc + 1):
                    for q in grid.get((i, j), ()):
                        if dist_m((la, lo), q, klon) < km * 1000:
                            return True
        return False

    # ---- 水系 ----
    rivers, lakes = OrderedDict(), OrderedDict()
    dropped_water = 0
    dropped_lake = 0
    for (_, _), e in water_el.items():
        t = e.get('tags', {})
        nm = t.get('name')
        if not nm:
            continue
        if e['type'] == 'way':
            pts = [(p['lat'], p['lon']) for p in (e.get('geometry') or [])]
        else:
            pts = stitch_members(e, klon)
        if len(pts) < 2:
            continue
        if not inside(pts):
            dropped_water += 1
            continue
        is_poly = (t.get('natural') == 'water') or (t.get('waterway') is None and len(pts) > 8)
        target = lakes if is_poly else rivers
        tol = TOL_LAKE if is_poly else tol_water
        if is_poly:                     # 小水塘/小鱼塘不画（面积按经纬度换算成 km²）
            las = [p[0] for p in pts]
            los = [p[1] for p in pts]
            area_km2 = ((max(las) - min(las)) * KM_PER_DEG_LAT) * ((max(los) - min(los)) * klon)
            if area_km2 < lake_min:
                dropped_lake += 1
                continue
        if nm in target and poly_len_km(pts, klon) <= poly_len_km(target[nm][0], klon):
            continue
        target[nm] = (rdp(pts, tol, klon), t.get('waterway') or 'water')

    # ---- 道路 ----
    roads_out = []
    stat = defaultdict(lambda: [0, 0])       # cls -> [段数, 点数]
    for (_, _), e in road_el.items():
        cls = e.get('tags', {}).get('highway')
        if cls not in ('motorway', 'trunk', 'primary'):
            continue
        pts = [(p['lat'], p['lon']) for p in (e.get('geometry') or [])]
        if len(pts) < 2:
            continue
        if not inside(pts):
            stat['-> 裁剪掉（超出可视范围）'][0] += 1
            continue
        if poly_len_km(pts, klon) < road_min:
            stat['-> 太短丢弃（<%.0f m）' % (road_min * 1000)][0] += 1
            continue
        near = near_track(pts, near_km)
        if not near and cls == 'primary':
            stat['primary(far,丢弃)'][0] += 1
            continue
        tol = tol_near if near else tol_far
        simp = rdp(pts, tol, klon)
        roads_out.append({'c': cls, 'near': near, 'pts': simp})
        stat[cls + ('(near)' if near else '(far)')][0] += 1
        stat[cls + ('(near)' if near else '(far)')][1] += len(simp)

    print('== 水系：河流/渠道 %d 条、湖泊 %d 个（抽稀后 %d 点）；裁剪掉 %d 个要素，小水塘丢弃 %d 个'
          % (len(rivers), len(lakes),
             sum(len(v[0]) for v in rivers.values()) + sum(len(v[0]) for v in lakes.values()),
             dropped_water, dropped_lake))
    print('== 道路：')
    for k in sorted(stat):
        print('   %-16s 段 %5d  点 %6d' % (k, stat[k][0], stat[k][1]))
    n_road_pts = sum(len(r['pts']) for r in roads_out)

    water = {
        'rivers': [{'name': n, 'pts': shift_xy(v[0])} for n, v in rivers.items()],
        'lakes': [{'name': n, 'pts': shift_xy(v[0])} for n, v in lakes.items()],
    }
    roads = [{'c': r['c'], 'pts': shift_xy(r['pts'])} for r in roads_out]

    text = json.dumps({'water': water, 'roads': roads}, ensure_ascii=False, separators=(',', ':'))
    kb = len(text.encode('utf-8')) / 1024.0
    print('== 结果：%d 条河 / %d 个湖 / %d 段道路（%d 点）→ basemap.json %.1f KB'
          % (len(water['rivers']), len(water['lakes']), len(roads), n_road_pts, kb))
    if not report:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(text)
        print('== 已写入 %s' % out_path)
    else:
        print('== --report 模式：未写文件')


if __name__ == '__main__':
    main()
