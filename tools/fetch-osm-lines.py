#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch-osm-lines.py — 抓取成都地铁各线路的 OSM 原始数据到 /tmp/osm-lines/<line>.json

为什么用 OSM API 而不是 Overpass：Overpass 经常限流（会返回 HTML 错误页），而
  https://api.openstreetmap.org/api/0.6/relation/<id>/full.json
一次就返回该关系的全部成员，**并且包含成员 way 用到的所有节点坐标**，正合适。
（Overpass 模式保留在 --overpass 参数里，作为备用。）

输出：
  { "line": "3", "rels": [8297265],
    "stops": [ {name, name_en, lat, lon, ref, role} ... ],       # 按关系成员顺序
    "ways":  [ {id, tags, geometry:[{lat,lon}...]} ... ] }        # 轨迹，按成员顺序
已存在的非空文件默认跳过（-f 强制重抓）。
"""
import json
import os
import subprocess
import sys
import time

OUT_DIR = '/tmp/osm-lines'
API = 'https://api.openstreetmap.org/api/0.6/relation/%d/full.json'
UA = 'doudou-metro-map/1.0 (personal schematic map; contact: local user)'

LINES = {
    '1main':   [8297247],              # 韦家碾→科学城（主线）
    '1branch': [7913598],              # 韦家碾→五根松（支线）
    '2':  [2474349],                   # 犀浦 → 龙泉驿
    '3':  [8297265],                   # 双流西站 => 成都医学院
    '4':  [6385133],                   # 万盛 => 西河
    '5':  [9627905],                   # 华桂路 => 回龙
    '6':  [9627850],                   # 望丛祠 => 兰家沟
    '7':  [8297136],                   # 外环（环线）
    '8':  [9761272],                   # 桂龙路 → 龙港
    '9':  [9627519],                   # 金融城东 → 黄田坝
    '10': [8298253],                   # 新平 → 武侯祠站
    # ↑ 10 号线注意：OSM 上它有 4 个关系（8298253 新平→武侯祠、7913594 武侯祠→新平、
    #   11807052 花桥→武侯祠、11807053 武侯祠→花桥）。**只能取一个方向的**，
    #   早期写的 [8298253, 11807053] 会把线路来回折一遍：站点里太平园/簇锦/华兴…各出现两次，
    #   轨道长 72.36 km（真实约 36 km）。方向相反的关系不能拼，要拼也只有同向的不同区段才能拼。
    '13': [19975015],                  # 瓦窑滩 → 龙安
    '17': [9851799],                   # 九江北 → 高洪
    '18': [9869750],                   # 火车南站 => 天府机场北
    '19': [16764493],                  # 天府机场北 => 金星
    '27': [12123402],                  # 石佛 => 蜀鑫路
    '30': [19970754],                  # 双流机场2航站楼东 → 龙泉驿火车站南
    'S3': [11516374],                  # 资阳北站 → 福田（市域铁路）
    # ---- 有轨电车（route=tram，轨道 way 的标签是 railway=tram）----
    # 主线只取一个方向：OSM 里有 T2 双方向（10490620 郫县西站→成都西站、9321938 反向），
    # 反向的关系不能与正向拼，取 10490620；支线 T2B 同理取正向 10490762（新业路→仁和）。
    'T2':  [10490620],                 # 郫县西站 → 成都西站（有轨电车蓉2号线主线）
    'T2B': [10490762],                 # 新业路 → 仁和（蓉2号线支线）
}


def fetch_full(rel_id):
    cmd = ['curl', '-s', '--max-time', '180', '-A', UA, API % rel_id]
    for attempt in range(1, 5):
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=200).stdout
            d = json.loads(out)
            if d.get('elements'):
                return d
            print('    ! 第 %d 次：返回空（%s）' % (attempt, str(d)[:80]), file=sys.stderr)
        except Exception as e:
            print('    ! 第 %d 次失败：%s' % (attempt, e), file=sys.stderr)
        time.sleep(6 * attempt)
    return None


def parse(d, rel_id):
    el = d['elements']
    rel = [e for e in el if e['type'] == 'relation' and e['id'] == rel_id]
    nodes = {e['id']: e for e in el if e['type'] == 'node'}
    ways = {e['id']: e for e in el if e['type'] == 'way'}
    if not rel:
        return None
    rel = rel[0]
    stops = []
    for m in rel.get('members', []):
        if m['type'] != 'node':
            continue
        n = nodes.get(m['ref'])
        if not n:
            continue
        t = n.get('tags', {})
        if t.get('railway') not in ('stop', 'station') and \
           t.get('public_transport') not in ('stop_position', 'station'):
            continue
        stops.append({
            'name': t.get('name') or t.get('name:zh') or '',
            'name_en': t.get('name:en', ''),
            'lat': n['lat'], 'lon': n['lon'],
            'ref': t.get('ref', ''),
            'role': m.get('role', ''),
        })
    track = []
    for m in rel.get('members', []):
        if m['type'] != 'way':
            continue
        w = ways.get(m['ref'])
        if not w:
            continue
        t = w.get('tags', {})
        if t.get('railway') not in ('subway', 'rail', 'light_rail', 'tram', None):
            continue
        geom = []
        for nid in w.get('nodes', []):
            n = nodes.get(nid)
            if n:
                geom.append({'lat': n['lat'], 'lon': n['lon']})
        if len(geom) < 2:
            continue
        track.append({'id': w['id'], 'tags': t, 'geometry': geom})
    return {'line': None, 'rels': [], 'stops': stops, 'ways': track}


def main():
    force = '-f' in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    todo = []
    for line, rels in LINES.items():
        path = os.path.join(OUT_DIR, '%s.json' % line)
        ok = False
        if os.path.exists(path) and not force:
            try:
                d = json.load(open(path, encoding='utf-8'))
                ok = bool(d.get('stops')) and bool(d.get('ways'))
                if ok:
                    print('%-4s 跳过（已有 %d 站 / %d 段）' % (line, len(d['stops']), len(d['ways'])))
            except Exception:
                ok = False
        if not ok:
            todo.append((line, rels, path))
    for line, rels, path in todo:
        stops, ways, got = [], [], []
        for rid in rels:
            d = fetch_full(rid)
            if not d:
                print('%-4s rel %d 抓取失败' % (line, rid), file=sys.stderr)
                continue
            r = parse(d, rid)
            if not r:
                print('%-4s rel %d 解析失败（无关系）' % (line, rid), file=sys.stderr)
                continue
            got.append(rid)
            stops.extend(r['stops'])
            ways.extend(r['ways'])
            time.sleep(2)
        if not stops or not ways:
            print('%-4s ✗ 站点 %d / 轨道段 %d，跳过不写（下次重试）' % (line, len(stops), len(ways)), file=sys.stderr)
            if os.path.exists(path):
                os.remove(path)
            continue
        data = {'line': line, 'rels': got, 'stops': stops, 'ways': ways}
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        pts = sum(len(w['geometry']) for w in ways)
        print('%-4s ✓ rels=%s 站点=%3d 轨道段=%3d 轨道点=%5d -> %s'
              % (line, got, len(stops), len(ways), pts, path))
    print('== 完成。已有文件：', sorted(os.listdir(OUT_DIR)))


if __name__ == '__main__':
    main()
