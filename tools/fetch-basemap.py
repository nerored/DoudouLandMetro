#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch-basemap.py — 抓取**全网**（1~30 号线 + S3）范围内的 OSM 水系 / 湖泊 / 快速路到 /tmp/basemap-raw/

为什么要扩：6 号线南端（兰家沟）、龙泉驿以东、天府机场方向原先落在底图之外，
      那片没有任何水系与道路（空白）。上线 8/9/10/13/17/18/19/27/30/S3 之前必须先把底图铺满。

为什么分块：整块 87 km × 94 km 的 bbox 一次查 Overpass 很容易超时/被限流，
      切成 4×4 个小块分别查，单块失败只重试那一块，也方便断点续抓。

输出（每块一个文件，按 element id 去重后由 tools/build-basemap.py 合并）：
  /tmp/basemap-raw/water-<i>.json   水系：waterway=river|canal|stream 与 natural=water（含 relation）
  /tmp/basemap-raw/roads-<i>.json   快速路：highway=motorway|trunk|primary
已存在的非空文件默认跳过（-f 强制重抓）。

用法:
  python3 tools/fetch-basemap.py          # 断点续抓（已抓好的块跳过）
  python3 tools/fetch-basemap.py -f       # 全部重抓
  python3 tools/fetch-basemap.py 3 5      # 只抓第 3 行第 5 列（调试单块）
"""
import json
import os
import random
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

OUT_DIR = '/tmp/basemap-raw'

# 全网线路 + 站点 + 站点名的地理包围盒（tools/build-basemap.py --extent 可复核）
# 数据依据：/tmp/osm-lines/*.json 全部轨道点 lat 30.1103..30.8313, lon 103.7794..104.6807
LAT_MIN, LAT_MAX = 30.06, 30.90
LON_MIN, LON_MAX = 103.70, 104.74
STEP = 0.27          # 块大小（度，纬度方向 ≈ 30 km）
PAD = 0.012          # 块向外扩一点，避免跨块的 way 在拼接处断头

ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]
# Overpass 全挂时的兜底：OSM API 的 map 调用（一次返回 bbox 内全部元素，XML）。
# 限制：单次面积 ≤ 0.25 deg²，元素数也有上限，所以下面用 MAP_SPLIT 再切小。
OSM_MAP = 'https://api.openstreetmap.org/api/0.6/map?bbox=%(w)f,%(s)f,%(e)f,%(n)f'
MAP_SPLIT = 3
UA = 'doudou-metro-map/1.0 (personal schematic map; contact: local user)'

B = '%(s)f,%(w)f,%(n)f,%(e)f'

# 只查 river/canal + natural=water：stream 在城郊数量极大（单块就上万点）且旧版底图里一条都没用到，
# 查它会让 Overpass 超时（实测 tile 1 的 water 查询连试三次都返回空）。
Q_WATER = ('[out:json][timeout:180];('
           'way["waterway"~"^(river|canal)$"](' + B + ');'
           'relation["waterway"~"^(river|canal)$"](' + B + ');'
           'way["natural"="water"](' + B + ');'
           'relation["natural"="water"](' + B + ');'
           ');out geom;')

Q_ROADS = '[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary)$"](' + B + ');out geom;'


def tiles():
    out = []
    lat = LAT_MIN
    r = 0
    while lat < LAT_MAX:
        lon = LON_MIN
        c = 0
        while lon < LON_MAX:
            out.append((r, c,
                        max(LAT_MIN, lat - PAD), max(LON_MIN, lon - PAD),
                        min(LAT_MAX, lat + STEP + PAD), min(LON_MAX, lon + STEP + PAD)))
            lon += STEP
            c += 1
        lat += STEP
        r += 1
    return out


OP_FAILS = 0          # Overpass 连续失败次数：≥2 就直接走 OSM API 兜底，不再干等退避重试


def overpass(query):
    """按端点轮换 + 指数退避重试；返回 elements 列表（失败返回 None）
    （并发太高时 Overpass 会直接返回空主体，所以每个请求先随机错开一下）"""
    time.sleep(random.uniform(0, 3))
    global OP_FAILS
    for attempt in range(1, 8):
        url = ENDPOINTS[(attempt - 1) % len(ENDPOINTS)]
        try:
            p = subprocess.run(
                ['curl', '-s', '--max-time', '300', '-A', UA, '--data-urlencode', 'data=' + query, url],
                capture_output=True, timeout=320)
            d = json.loads(p.stdout or b'')
            if d.get('elements') is not None:
                OP_FAILS = 0
                return d['elements']
            print('    ! 第 %d 次：%s 返回异常：%s' % (attempt, url.split('/')[2], str(d)[:100]), file=sys.stderr)
        except Exception as e:
            print('    ! 第 %d 次失败（%s）：%s' % (attempt, url.split('/')[2], e), file=sys.stderr)
        time.sleep(8 * attempt)
    OP_FAILS += 1
    return None


def osm_map_bbox(s, w, n, e):
    """OSM API map 调用（一次），返回 (water_els, road_els)，失败返回 (None, None)"""
    import xml.etree.ElementTree as ET
    url = OSM_MAP % {'w': w, 's': s, 'e': e, 'n': n}
    for attempt in range(1, 4):
        try:
            p = subprocess.run(['curl', '-s', '--max-time', '300', '-A', UA, url],
                               capture_output=True, timeout=320)
            if not p.stdout or not p.stdout.lstrip().startswith(b'<?xml'):
                raise ValueError('非 XML 响应 %r' % (p.stdout[:90],))
            root = ET.fromstring(p.stdout)
            nodes = {nd.get('id'): (float(nd.get('lat')), float(nd.get('lon'))) for nd in root.findall('node')}
            water, roads = [], []
            for wy in root.findall('way'):
                tags = {t.get('k'): t.get('v') for t in wy.findall('tag')}
                ww, nat, hw = tags.get('waterway'), tags.get('natural'), tags.get('highway')
                is_water = ww in ('river', 'canal') or nat == 'water'
                if not (is_water or hw in ('motorway', 'trunk', 'primary')):
                    continue
                geom = []
                for nd in wy.findall('nd'):
                    c = nodes.get(nd.get('ref'))
                    if c:
                        geom.append({'lat': c[0], 'lon': c[1]})
                if len(geom) < 2:
                    continue
                el = {'type': 'way', 'id': int(wy.get('id')), 'tags': tags, 'geometry': geom}
                (water if is_water else roads).append(el)
            return water, roads
        except Exception as ex:
            print('    ! OSM map 第 %d 次失败：%s' % (attempt, ex), file=sys.stderr)
            time.sleep(5 * attempt)
    return None, None


def osm_map_elements(s, w, n, e):
    """把一个 tile 再切成 MAP_SPLIT×MAP_SPLIT 小块调 OSM API，合并后返回 (water, roads)"""
    ws, rs = [], []
    dlat = (n - s) / MAP_SPLIT
    dlon = (e - w) / MAP_SPLIT
    for rr in range(MAP_SPLIT):
        for cc in range(MAP_SPLIT):
            w2, w1 = w + cc * dlon, s + rr * dlat
            fw, fr = osm_map_bbox(w1, w2, w1 + dlat, w2 + dlon)
            if fw is None:
                return None, None
            ws.extend(fw)
            rs.extend(fr)
    return ws, rs


_FALLBACK_CACHE = {}


def grab(kind, idx, query, bbox=None):
    path = os.path.join(OUT_DIR, '%s-%d.json' % (kind, idx))
    if os.path.exists(path) and os.path.getsize(path) > 20 and '-f' not in sys.argv:
        try:
            d = json.load(open(path, encoding='utf-8'))
            if d.get('elements'):
                return 'skip', len(d['elements'])
        except Exception:
            pass
    els = None
    if OP_FAILS < 2:
        els = overpass(query)
    if els is None and bbox:
        key = tuple(sorted(bbox.items()))
        if key not in _FALLBACK_CACHE:
            print('    · Overpass 不可用，改用 OSM API map 兜底（%d×%d 小块）' % (MAP_SPLIT, MAP_SPLIT), file=sys.stderr)
            _FALLBACK_CACHE[key] = osm_map_elements(**bbox)
        fw, fr = _FALLBACK_CACHE[key]
        els = fw if kind == 'water' else fr
    if els is None:
        return 'fail', 0
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'elements': els}, f, ensure_ascii=False)
    os.replace(tmp, path)                 # 原子写入：并发/中断都不会留下半截文件
    return 'ok', len(els)


def main():
    if not sys.stdout.isatty():
        sys.stdout.reconfigure(line_buffering=True)     # 后台跑时也要能实时看进度
    os.makedirs(OUT_DIR, exist_ok=True)
    only = None
    args = [a for a in sys.argv[1:] if a not in ('-f',)]
    jobs = 4
    if '-j' in args:
        i = args.index('-j')
        jobs = max(1, int(args[i + 1]))
        args = args[:i] + args[i + 2:]
    if len(args) == 2:
        only = (int(args[0]), int(args[1]))
    ts = tiles()
    print('== 底图抓取：%d 块（每块 %.2f° ≈ %.0f km），bbox lat %.2f..%.2f lon %.2f..%.2f，并发 %d'
          % (len(ts), STEP, STEP * 110.574, LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, jobs))
    todo = [t for t in ts if not only or (t[0], t[1]) == only]
    tot = {'water': 0, 'roads': 0}
    fails = []

    def work(item):
        i, (r, c, s, w, n, e) = item
        hits = []
        bad = []
        for kind, q in (('water', Q_WATER), ('roads', Q_ROADS)):
            st, n_el = grab(kind, i, q % {'s': s, 'w': w, 'n': n, 'e': e},
                            {'s': s, 'w': w, 'n': n, 'e': e})
            hits.append('%s %s(%d)' % (kind, st, n_el))
            if st == 'fail':
                bad.append((i, kind))
            elif st == 'ok':
                tot[kind] += n_el
        print('  [%2d] r%d c%d lat %.2f..%.2f lon %.2f..%.2f  %s'
              % (i, r, c, s, n, w, e, '  '.join(hits)))
        return bad

    with ThreadPoolExecutor(max_workers=jobs) as ex:
        for bad in ex.map(work, enumerate(todo)):
            fails.extend(bad)
    print('== 完成：新抓 water %d / roads %d 个元素；失败 %d 块 %s'
          % (tot['water'], tot['roads'], len(fails), fails if fails else ''))
    files = sorted(os.listdir(OUT_DIR))
    print('== 缓存文件 %d 个：%s' % (len(files), files))


if __name__ == '__main__':
    main()
