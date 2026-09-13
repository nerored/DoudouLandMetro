#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-data.py — 由 OSM 数据生成 data.js（成都地铁 1 号线 / 2 号线示意线路图）

⚠️ 这是一次性数据生成脚本，运行网页应用**不需要**它（应用仍是零构建的静态页面）。
   它的作用是让 data.js 里的几何与里程可追溯、可复现。

输入（默认 /tmp，可由命令行参数覆盖）：
  /tmp/members.json   OSM 关系 8297247（1 号线 韦家碾→科学城）与 2474349（2 号线 犀浦→龙泉驿）的成员站点
  /tmp/br.json        OSM 支线站点（广都 / 五根松）
  /tmp/ways2.json     OSM 轨道 way 几何（1 号线 3 段 + 2 号线 15 段）与 2474349 的 way 顺序
  /tmp/water.json     OSM 水系（waterway）与湖泊（natural=water）
  /tmp/roads.json     OSM 主干道（motorway / trunk / primary）

输出：../data.js

坐标系：局部等距圆柱投影（以 lat0=30.58 为基准），1 km = 50 地图单位，不做任何横纵夸张，
        因此图上形状与真实地理一致（南北向 1 号线 + 东西向 2 号线，天府广场为唯一交点）。
里程：直接采用 OSM 轨道几何的弧长（真实里程，不做等比缩放）。
"""

import json
import math
import sys
from collections import OrderedDict

# --------------------------------------------------------------------------- 常量
LAT0, LON0 = 30.58, 104.06
KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(LAT0))
UNITS_PER_KM = 50.0
MARGIN_UNITS = 200.0

TOL_TRACK = 3.0      # 米：轨道折线抽稀容差
TOL_WATER = 12.0     # 米：河流
TOL_LAKE = 8.0       # 米：湖泊轮廓
TOL_ROAD = 34.0      # 米：道路（仅作底图装饰，抽稀狠一点）
ROAD_POINT_CAP = 4200

LINE_COLORS = {'1': '#0d6cb5', '2': '#e8792a'}   # 2 号线橙色为近似值（待核实）

# OSM way id -> 轨道段（顺序即行进方向）
TRACK_WAYS = OrderedDict([
    ('1trunk',  [886460244]),   # 韦家碾 → 四河
    ('1main',   [886460243]),   # 四河 → 科学城
    ('1branch', [886460241]),   # 四河 → 五根松
    ('2', [843327902, 613616268, 847898146, 864169889, 1026180148, 1026180144,
           865542535, 865542534, 770984251, 780502300, 1476729028, 1476729027,
           324930883, 1115655067, 1115655068]),   # 犀浦 → 龙泉驿（关系成员顺序）
])

# 轨道段应有的起终点站点（用于方向自检与必要时整段反向）
TRACK_ENDS = {
    '1trunk':  ('韦家碾', '四河'),
    '1main':   ('四河', '科学城'),
    '1branch': ('四河', '五根松'),
    '2':       ('犀浦', '龙泉驿'),
}

# 站点 id（拼音）与元数据；tr=已开通换乘线路，planned=在建/规划，form=车站形式（1 号线来自百科表）
STATION_META = OrderedDict([
    ('韦家碾',        dict(id='weijianian', en='Weijianian', form='地下侧式', tr=['27'], planned=['S11'])),
    ('升仙湖',        dict(id='shengxianhu', en='Shengxian Lake', form='地下岛式', tr=[])),
    ('火车北站',      dict(id='huochebeizhan', en='North Railway Station', form='地下岛式', tr=['7'], planned=['18'])),
    ('人民北路',      dict(id='renminbeilu', en='Renmin North Road', form='地下岛式', tr=['6'])),
    ('文殊院',        dict(id='wenshuyuan', en='Wenshu Monastery', form='地下岛式', tr=[])),
    ('骡马市',        dict(id='luomashi', en='Luomashi', form='地下岛式', tr=['4'], planned=['10', '18'])),
    ('天府广场',      dict(id='tianfuguangchang', en='Tianfu Square', form='地下西班牙式', tr=['1', '2'])),
    ('锦江宾馆',      dict(id='jinjiangbinguan', en='Jinjiang Hotel', form='地下岛式', tr=[])),
    ('华西坝',        dict(id='huaxiba', en='Huaxiba', form='地下岛式', tr=['13'])),
    ('省体育馆',      dict(id='shengtiyuguan', en='Sichuan Gymnasium', form='地下岛式', tr=['3'], planned=['18'])),
    ('倪家桥',        dict(id='nijiaqiao', en='Nijiaqiao', form='地下岛式', tr=['8'], planned=['18'])),
    ('桐梓林',        dict(id='tongzilin', en='Tongzilin', form='地下岛式', tr=[])),
    ('火车南站',      dict(id='huochenanzhan', en='South Railway Station', form='地下岛式', tr=['7', '18'])),
    ('高新',          dict(id='gaoxin', en='Hi-Tech Zone', form='地下侧式', tr=[])),
    ('金融城',        dict(id='jinrongcheng', en='Financial City', form='地下岛式', tr=[])),
    ('孵化园',        dict(id='fuhuayuan', en='Incubation Park', form='地下岛式', tr=['9', '18'])),
    ('锦城广场',      dict(id='jinchengplaza', en='Jincheng Plaza', form='地下岛式', tr=[])),
    ('世纪城',        dict(id='shijicheng', en='Century City', form='地下岛式', tr=['18'])),
    ('天府三街',      dict(id='tianfusanjie', en='3rd Tianfu Street', form='地下岛式', tr=[])),
    ('天府五街',      dict(id='tianfuwujie', en='5th Tianfu Street', form='地下岛式', tr=[])),
    ('华府大道',      dict(id='huafudadao', en='Huafu Avenue', form='地下岛式', tr=[])),
    ('四河',          dict(id='sihe', en='Sihe', form='地下双岛式', tr=[], planned=['15'])),
    ('华阳',          dict(id='huayang', en='Huayang', form='地下岛式', tr=[])),
    ('海昌路',        dict(id='haichanglu', en='Haichang Road', form='地下岛式', tr=['18'])),
    ('广福',          dict(id='guangfu', en='Guangfu', form='地下岛式', tr=[])),
    ('红石公园',      dict(id='hongshigongyuan', en='Hongshi Park', form='地下岛式', tr=[])),
    ('麓湖',          dict(id='luhu', en='Luhu Lake', form='地下岛式', tr=[])),
    ('武汉路',        dict(id='wuhanlu', en='Wuhan Road', form='地下岛式', tr=[])),
    ('天府公园',      dict(id='tianfugongyuan', en='Tianfu Park', form='地下岛式', tr=[])),
    ('西博城',        dict(id='xibocheng', en="Western China Int'l Expo City", form='地下岛式', tr=['6', '18'])),
    ('广州路',        dict(id='guangzhoulu', en='Guangzhou Road', form='地下岛式', tr=[])),
    ('兴隆湖',        dict(id='xinglonghu', en='Xinglong Lake', form='地下岛式', tr=[])),
    ('科学城',        dict(id='kexuecheng', en='Science City', form='地下侧式', tr=[])),
    ('广都',          dict(id='guangdu', en='Guangdu', form='地下岛式', tr=[])),
    ('五根松',        dict(id='wugensong', en='Wugensong', form='地下岛式', tr=[])),
    # ---- 2 号线（车站形式百科表未给，留空待核实） ----
    ('犀浦',          dict(id='xipu', en='Xipu Railway Station', tr=['6'])),
    ('天河路',        dict(id='tianhelu', en='Tianhe Road')),        # 蓉2号线支线换乘由 build-lines.py 按同名站自动合并给出
    ('百草路',        dict(id='baicaolu', en='Baicao Road', tr=[])),
    ('金周路',        dict(id='jinzhoulu', en='Jinzhou Road', tr=[])),
    ('金科北路',      dict(id='jinkebeilu', en='Jinke North Road', tr=[])),
    ('迎宾大道',      dict(id='yingbindadao', en='Yingbin Avenue', tr=[], planned=['12'])),
    ('茶店子客运站',  dict(id='chadianzi', en='Chadianzi Bus Terminal', tr=[])),
    ('羊犀立交',      dict(id='yangxilijiao', en='Yangxi Flyover', tr=['27'])),
    ('一品天下',      dict(id='yipintianxia', en='Yipintianxia', tr=['7'])),
    ('蜀汉路东',      dict(id='shuhanludong', en='Shuhan Road East', tr=[])),
    ('白果林',        dict(id='baiguolin', en='Baiguolin', tr=[])),
    ('中医大·省医院', dict(id='zhongyida', en='Chengdu Univ. of TCM & Sichuan Prov. People\'s Hospital', tr=['4', '5'])),
    ('通惠门',        dict(id='tonghuimen', en='Tonghuimen', tr=[])),
    ('人民公园',      dict(id='renmingongyuan', en="People's Park", tr=[], planned=['10', '17'])),
    ('春熙路',        dict(id='chunxilu', en='Chunxi Road', tr=['3'], planned=['23'])),
    ('东门大桥',      dict(id='dongmenqiao', en='Dongmen Bridge', tr=[])),
    ('牛王庙',        dict(id='niuwangmiao', en='Niuwangmiao', tr=['6'])),
    ('牛市口',        dict(id='niushikou', en='Niushikou', tr=[])),
    ('东大路',        dict(id='dongdalu', en='Dongdalu Road', tr=['8'])),
    ('塔子山公园',    dict(id='tazishangongyuan', en='Tazishan Park', tr=[])),
    ('成都东客站',    dict(id='chengdudongkezhan', en='Chengdu East Railway Station', tr=['7'], planned=['20'])),
    ('成渝立交',      dict(id='chengyulijiao', en='Chengyu Flyover', tr=[])),
    ('惠王陵',        dict(id='huiwangling', en='Huiwangling', tr=['30'])),
    ('洪河',          dict(id='honghe', en='Honghe', tr=[])),
    ('成都行政学院',  dict(id='chengdouxingzheng', en='Chengdu Academy of Governance', tr=[])),
    ('龙泉驿火车站',  dict(id='longquanyihuochezhan', en='Longquanyi Railway Station', tr=['30'], status='在建', no_stop=True)),
    ('大面铺',        dict(id='damianpu', en='Damianpu', tr=[], status='暂停运营')),
    ('连山坡',        dict(id='lianshanpo', en='Lianshanpo', tr=[], status='暂停运营')),
    ('界牌',          dict(id='jiepai', en='Jiepai', tr=[], status='暂停运营')),
    ('书房',          dict(id='shufang', en='Shufang', tr=[], status='暂停运营')),
    ('龙平路',        dict(id='longpinglu', en='Longping Road', tr=[], status='暂停运营')),
    ('龙泉驿',        dict(id='longquanyi', en='Longquanyi', tr=[], status='暂停运营')),
])

TERMINUS = {'韦家碾', '科学城', '五根松', '犀浦', '龙泉驿'}

# 交路（服务模式）
L1_MAIN = ['韦家碾', '升仙湖', '火车北站', '人民北路', '文殊院', '骡马市', '天府广场', '锦江宾馆',
           '华西坝', '省体育馆', '倪家桥', '桐梓林', '火车南站', '高新', '金融城', '孵化园',
           '锦城广场', '世纪城', '天府三街', '天府五街', '华府大道', '四河', '华阳', '海昌路',
           '广福', '红石公园', '麓湖', '武汉路', '天府公园', '西博城', '广州路', '兴隆湖', '科学城']
L1_BRANCH = L1_MAIN[:22] + ['广都', '五根松']
L2_MAIN = ['犀浦', '天河路', '百草路', '金周路', '金科北路', '迎宾大道', '茶店子客运站', '羊犀立交',
           '一品天下', '蜀汉路东', '白果林', '中医大·省医院', '通惠门', '人民公园', '天府广场',
           '春熙路', '东门大桥', '牛王庙', '牛市口', '东大路', '塔子山公园', '成都东客站',
           '成渝立交', '惠王陵', '洪河', '成都行政学院', '龙泉驿火车站', '大面铺', '连山坡',
           '界牌', '书房', '龙平路', '龙泉驿']

SERVICES = [
    dict(key='1main', line='1', label='韦家碾 ↔ 科学城（主线）', tracks=['1trunk', '1main'], stops=L1_MAIN),
    dict(key='1branch', line='1', label='韦家碾 ↔ 五根松（支线）', tracks=['1trunk', '1branch'], stops=L1_BRANCH),
    dict(key='2main', line='2', label='犀浦 ↔ 龙泉驿', tracks=['2'], stops=L2_MAIN),
]

# 龙泉驿火车站为“改建加站·在建”，OSM 尚无停靠点，按轨道几何插在成都行政学院—大面铺之间（示意位置，待核实）
INSERT_AFTER = {'龙泉驿火车站': '成都行政学院'}


# --------------------------------------------------------------------- 几何工具
def project(lat, lon):
    x = (lon - LON0) * KM_PER_DEG_LON * UNITS_PER_KM
    y = (LAT0 - lat) * KM_PER_DEG_LAT * UNITS_PER_KM
    return (x, y)


def dist_m(a, b):
    """经纬度点距离（米，局部近似）"""
    dlat = (b[0] - a[0]) * KM_PER_DEG_LAT * 1000.0
    dlon = (b[1] - a[1]) * KM_PER_DEG_LON * 1000.0
    return math.hypot(dlat, dlon)


def rdp(points, tol_m):
    """Douglas-Peucker 抽稀（输入经纬度点列）"""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        ax, ay = points[i0][1], points[i0][0]        # 用经纬度做平面近似
        bx, by = points[i1][1], points[i1][0]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best_i, best_d = -1, -1.0
        for i in range(i0 + 1, i1):
            px, py = points[i][1], points[i][0]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            d_m = d * KM_PER_DEG_LAT * 1000.0        # 度 → 米（近似）
            if d_m > best_d:
                best_d, best_i = d_m, i
        if best_d > tol_m:
            keep[best_i] = True
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return [p for p, k in zip(points, keep) if k]


def stitch(ways_geom):
    """按顺序把 way 折线首尾相接（必要时反向）"""
    out = []
    for g in ways_geom:
        pts = [(p['lat'], p['lon']) for p in g]
        if not pts:
            continue
        if not out:
            out = pts[:]
            continue
        tail = out[-1]
        if dist_m(tail, pts[0]) <= dist_m(tail, pts[-1]):
            out.extend(pts[1:])
        else:
            out.extend(reversed(pts[:-1]))
    return out


def poly_len_km(pts):
    total = 0.0
    for i in range(1, len(pts)):
        total += dist_m(pts[i - 1], pts[i]) / 1000.0
    return total


def nearest_on_polyline(pts_xy, p):
    """把点投影到折线上，返回 (弧长(单位), 垂足 xy, 距离)"""
    best = (0.0, pts_xy[0], float('inf'))
    acc = 0.0
    for i in range(1, len(pts_xy)):
        ax, ay = pts_xy[i - 1]
        bx, by = pts_xy[i]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / seg2))
        fx, fy = ax + t * dx, ay + t * dy
        d = math.hypot(p[0] - fx, p[1] - fy)
        if d < best[2]:
            best = (acc + t * math.sqrt(seg2), (fx, fy), d)
        acc += math.sqrt(seg2)
    return best


# --------------------------------------------------------------------------- 读取
def load(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print('  !! 读取失败 %s: %s' % (path, e), file=sys.stderr)
        return default


def main():
    base = '/tmp'
    if len(sys.argv) > 1:
        base = sys.argv[1].rstrip('/')
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'data.js'

    print('== 读取 OSM 原始数据（%s）' % base)
    members = load(base + '/members.json', {'elements': []})
    br = load(base + '/br.json', {'elements': []})
    ways2 = load(base + '/ways2.json', {'elements': []})
    water = load(base + '/water.json', {'elements': []})
    roads = load(base + '/roads.json', {'elements': []})

    # ---- 1. 站点坐标（OSM stop 节点） ----
    stations = OrderedDict()          # 中文站名 -> dict(lat, lon)
    for src in (members, br):
        for e in src.get('elements', []):
            if e.get('type') != 'node':
                continue
            t = e.get('tags', {})
            nm = t.get('name')
            if not nm or nm not in STATION_META:
                continue
            if nm in stations:
                continue          # 同名多节点（上下行）取第一个
            stations[nm] = (e['lat'], e['lon'])
    missing = [k for k in STATION_META if k not in stations and k not in INSERT_AFTER]
    print('   站点坐标 %d 个，缺 %s' % (len(stations), missing or '无'))

    # ---- 2. 轨道几何 ----
    way_geom = {}
    for e in ways2.get('elements', []):
        if e.get('type') == 'way' and e.get('geometry'):
            way_geom[e['id']] = e['geometry']

    tracks = OrderedDict()
    for key, ids in TRACK_WAYS.items():
        geoms = [way_geom[i] for i in ids if i in way_geom]
        if not geoms:
            print('   !! 轨道 %s 缺少几何' % key, file=sys.stderr)
            continue
        pts = stitch(geoms)
        a, b = TRACK_ENDS[key]
        # 方向自检：起点应更靠近 a
        if a in stations and b in stations:
            if dist_m(pts[0], stations[a]) > dist_m(pts[-1], stations[a]):
                pts.reverse()
            d0 = dist_m(pts[0], stations[a])
            d1 = dist_m(pts[-1], stations[b])
            print('   轨道 %-8s 原始 %4d 点 %.2f km  起点距%s %.0f m  终点距%s %.0f m'
                  % (key, len(pts), poly_len_km(pts), a, d0, b, d1))
        raw_km = poly_len_km(pts)
        pts = rdp(pts, TOL_TRACK)
        tracks[key] = dict(pts=pts, km=raw_km, pts_raw=len(geoms and [p for g in geoms for p in g]))

    # ---- 3. 交路：拼接轨道 + 投影 + 站点里程 ----
    services = []
    for svc in SERVICES:
        poly = []
        for tk in svc['tracks']:
            if tk not in tracks:
                continue
            pts = tracks[tk]['pts']
            if poly and dist_m(poly[-1], pts[0]) > dist_m(poly[-1], pts[-1]):
                pts = list(reversed(pts))
            poly.extend(pts if not poly else pts[1:])
        xy = [project(la, lo) for (la, lo) in poly]
        # 站点在交路上的位置
        stops, s_at, d_at = [], [], []
        for nm in svc['stops']:
            if nm not in stations:
                print('   !! 站点 %s 无坐标，跳过' % nm, file=sys.stderr)
                continue
            s, foot, d = nearest_on_polyline(xy, project(*stations[nm]))
            stops.append(dict(name=nm, s=s, d=d))
        services.append(dict(key=svc['key'], line=svc['line'], label=svc['label'],
                             stops=stops, xy=xy, km=poly_len_km(poly)))

    for svc in services:
        print('   交路 %-8s %-22s 站点 %2d  轨道 %.2f km  最大投影误差 %.1f m'
              % (svc['key'], svc['label'], len(svc['stops']), svc['km'],
                 max(s['d'] for s in svc['stops']) if svc['stops'] else 0))

    # ---- 4. 世界坐标整体平移，使内容落在正数区域 ----
    xs, ys = [], []
    for svc in services:
        for x, y in svc['xy']:
            xs.append(x)
            ys.append(y)
    for nm, (la, lo) in stations.items():
        x, y = project(la, lo)
        xs.append(x)
        ys.append(y)
    off_x = -min(xs) + MARGIN_UNITS
    off_y = -min(ys) + MARGIN_UNITS

    def offset(xy_pts):
        """已投影的地图坐标 -> 平移后的最终坐标"""
        return [(round(x + off_x, 1), round(y + off_y, 1)) for x, y in xy_pts]

    def proj_shift(pts):
        """经纬度 -> 投影 -> 平移（轨道 / 水系 / 道路用）"""
        return offset([project(la, lo) for la, lo in pts])

    map_x0, map_y0 = MARGIN_UNITS, MARGIN_UNITS
    map_x1 = max(xs) + off_x - MARGIN_UNITS + 1
    map_y1 = max(ys) + off_y - MARGIN_UNITS + 1

    # ---- 5. 水系 / 湖泊 / 道路 ----
    def stitch_water(el):
        if el['type'] == 'way' and el.get('geometry'):
            return [(p['lat'], p['lon']) for p in el['geometry']]
        if el['type'] == 'relation':
            parts = [[(p['lat'], p['lon']) for p in (m.get('geometry') or [])]
                     for m in el.get('members', [])]
            parts = [p for p in parts if len(p) > 1]
            if not parts:
                return []
            out = parts[0]
            for p in parts[1:]:
                out = out + p if dist_m(out[-1], p[0]) < dist_m(out[-1], p[-1]) else out + list(reversed(p))
            return out
        return []

    rivers = OrderedDict()
    lakes = OrderedDict()
    for e in water.get('elements', []):
        t = e.get('tags', {})
        nm = t.get('name')
        if not nm:
            continue
        pts = stitch_water(e)
        if len(pts) < 2:
            continue
        is_poly = (e['type'] == 'way' and t.get('natural') == 'water') or \
                  (e['type'] == 'relation' and t.get('natural') == 'water') or \
                  (t.get('waterway') is None and len(pts) > 8)
        target = lakes if is_poly else rivers
        tol = TOL_LAKE if is_poly else TOL_WATER
        if nm in target:
            if poly_len_km(pts) <= poly_len_km(target[nm]):
                continue
        target[nm] = pts
    for d in (rivers, lakes):
        for nm in list(d.keys()):
            d[nm] = rdp(d[nm], TOL_LAKE if d is lakes else TOL_WATER)

    road_pts = []
    road_cls = []
    for e in roads.get('elements', []):
        g = e.get('geometry')
        if not g or len(g) < 2:
            continue
        pts = [(p['lat'], p['lon']) for p in g]
        road_pts.append(rdp(pts, TOL_ROAD))
        road_cls.append(e.get('tags', {}).get('highway', 'primary'))
    n_road = sum(len(p) for p in road_pts)
    if n_road > ROAD_POINT_CAP:                     # 超限时丢弃 primary，只留快速路骨架
        keep = [(p, c) for p, c in zip(road_pts, road_cls) if c in ('motorway', 'trunk')]
        road_pts = [p for p, c in keep]
        road_cls = [c for p, c in keep]
        print('   道路点过多，仅保留 motorway/trunk')
    n_road = sum(len(p) for p in road_pts)
    if n_road > ROAD_POINT_CAP:                     # 仍然过多则只留 motorway
        keep = [(p, c) for p, c in zip(road_pts, road_cls) if c == 'motorway']
        road_pts = [p for p, c in keep]
        road_cls = [c for p, c in keep]
        print('   道路点仍过多，仅保留 motorway')
    n_road = sum(len(p) for p in road_pts)

    # ---- 6. 生成 JS ----
    def js_pts(pts):
        """[x,y] 坐标对数组（应用端按 [x,y] 读取）"""
        return '[' + ','.join('[%g,%g]' % (x, y) for x, y in pts) + ']'

    lines_js = []
    for lk in ('1', '2'):
        svcs = [s for s in services if s['line'] == lk]
        lines_js.append(
            '{key:%s,name:%s,short:%s,color:%s,services:[%s]}' % (
                json.dumps(lk, ensure_ascii=False),
                json.dumps('成都地铁 %s 号线' % lk, ensure_ascii=False),
                json.dumps('%s号线' % lk, ensure_ascii=False),
                json.dumps(LINE_COLORS[lk]),
                ','.join('{key:%s,label:%s,stationIds:[%s],tracks:[%s]}' % (
                    json.dumps(s['key']), json.dumps(s['label'], ensure_ascii=False),
                    ','.join(json.dumps(STATION_META[q['name']]['id']) for q in s['stops']),
                    ','.join(json.dumps(t) for t in
                             next(x['tracks'] for x in SERVICES if x['key'] == s['key'])))
                    for s in svcs)))

    st_lines = {}
    for svc in services:
        for q in svc['stops']:
            st_lines.setdefault(q['name'], set()).add(svc['line'])
    # 站点在交路上的里程/位置（取它所属线路的第一个交路）
    st_km, st_xy = {}, {}
    for svc in services:
        xy = offset(svc['xy'])
        for q in svc['stops']:
            nm = q['name']
            if nm in st_km:
                continue
            st_km[nm] = round(q['s'] / UNITS_PER_KM, 2)     # OSM 轨道弧长 = 真实里程
            if q['s'] <= 1e-6:
                st_xy[nm] = xy[0]
            else:
                acc = 0.0
                for i in range(1, len(xy)):
                    seg = math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])
                    if acc + seg >= q['s']:
                        t = 0.0 if seg == 0 else (q['s'] - acc) / seg
                        st_xy[nm] = (round(xy[i - 1][0] + t * (xy[i][0] - xy[i - 1][0]), 1),
                                     round(xy[i - 1][1] + t * (xy[i][1] - xy[i - 1][1]), 1))
                        break
                    acc += seg

    # 在建的龙泉驿火车站：插在成都行政学院与下一站之间的轨道上
    for nm, anchor in INSERT_AFTER.items():
        if nm in st_xy:
            continue
        svc = next(s for s in services if any(q['name'] == nm for q in s['stops']))
        pts = [q for q in svc['stops'] if q['name'] in st_xy]
        a = next(i for i, q in enumerate(svc['stops']) if q['name'] == anchor)
        b = svc['stops'][a + 1]
        s_mid = (svc['stops'][a]['s'] + b['s']) / 2.0
        xy = offset(svc['xy'])
        acc = 0.0
        for i in range(1, len(xy)):
            seg = math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])
            if acc + seg >= s_mid:
                t = (s_mid - acc) / seg if seg else 0
                st_xy[nm] = (round(xy[i - 1][0] + t * (xy[i][0] - xy[i - 1][0]), 1),
                             round(xy[i - 1][1] + t * (xy[i][1] - xy[i - 1][1]), 1))
                st_km[nm] = round(s_mid / UNITS_PER_KM, 2)
                break
            acc += seg
        print('   %s（在建）按轨道插值于 %s 之后：km %.2f' % (nm, anchor, st_km.get(nm, -1)))
        # 由投影坐标反算经纬度（不借用邻站坐标）
        sxx, syy = st_xy[nm]
        lat_i = LAT0 - (syy - off_y) / UNITS_PER_KM / KM_PER_DEG_LAT
        lon_i = LON0 + (sxx - off_x) / UNITS_PER_KM / KM_PER_DEG_LON
        stations[nm] = (lat_i, lon_i)
        print('      反算坐标 %.5f, %.5f（示意位置，待核实）' % (lat_i, lon_i))

    station_js = []
    for nm, meta in STATION_META.items():
        if nm not in st_xy:
            continue
        lat, lon = stations.get(nm, (0, 0))
        ln = sorted(st_lines.get(nm, {'1'}))
        tr = [t for t in meta.get('tr', []) if t not in ln]      # 换乘 = 本站不经过的其他线路
        entry = OrderedDict()
        entry['id'] = meta['id']
        entry['zh'] = nm
        entry['en'] = meta.get('en', '')
        entry['x'] = st_xy[nm][0]
        entry['y'] = st_xy[nm][1]
        entry['lat'] = round(lat, 5)
        entry['lon'] = round(lon, 5)
        entry['lines'] = ln
        entry['tr'] = tr
        if meta.get('planned'):
            entry['planned'] = meta['planned']
        if meta.get('form'):
            entry['form'] = meta['form']
        if meta.get('status'):
            entry['status'] = meta['status']
        if meta.get('no_stop'):
            entry['noStop'] = True
        if nm in TERMINUS:
            entry['term'] = True
        if nm == '四河':
            entry['junction'] = True
        station_js.append(entry)

    out = []
    out.append('/* =============================================================================')
    out.append(' * data.js — 成都地铁 1 / 2 号线示意线路图数据（由 tools/build-data.py 生成，请勿手改）')
    out.append(' *')
    out.append(' * 站点顺序 / 换乘 / 车站形式 / 状态：百度百科词条《成都地铁1号线》《成都地铁2号线》')
    out.append(' *   （词条标注来源为成都地铁官网，抓取日期 2026-09-12）')
    out.append(' * 站点坐标与轨道几何：OpenStreetMap（© OpenStreetMap contributors, ODbL 1.0）')
    out.append(' *   关系 8297247（1 号线 韦家碾→科学城）、2474349（2 号线 犀浦→龙泉驿）')
    out.append(' *   轨道 way：1 号线 886460244 / 886460243 / 886460241，2 号线 15 段，取回日期 2026-09-12')
    out.append(' * 里程：直接采用 OSM 轨道几何弧长（真实里程，未做等比缩放）')
    out.append(' * 坐标系：局部等距圆柱投影（lat0=30.58），1 km = %.0f 单位，无横纵夸张' % UNITS_PER_KM)
    out.append(' * ========================================================================== */')
    out.append('window.METRO = (function () {')
    out.append("  'use strict';")
    out.append('  var lines = [' + ','.join(lines_js) + '];')
    out.append('  var stations = [' + ','.join(
        '{' + ','.join('%s:%s' % (k, json.dumps(v, ensure_ascii=False) if not isinstance(v, bool) else ('true' if v else 'false'))
                       for k, v in st.items()) + '}' for st in station_js) + '];')
    out.append('  var tracks = {};')
    for key, tr in tracks.items():
        out.append('  tracks[%s] = %s;' % (json.dumps(key), js_pts(proj_shift(tr['pts']))))
    out.append('  var water = {rivers:[%s],lakes:[%s]};' % (
        ','.join('{name:%s,pts:%s}' % (json.dumps(nm, ensure_ascii=False), js_pts(proj_shift(rdp(p, TOL_WATER))))
                 for nm, p in rivers.items()),
        ','.join('{name:%s,pts:%s}' % (json.dumps(nm, ensure_ascii=False), js_pts(proj_shift(p)))
                 for nm, p in lakes.items())))
    out.append('  var roads = [%s];' % ','.join(
        '{c:%s,pts:%s}' % (json.dumps(c), js_pts(proj_shift(p))) for p, c in zip(road_pts, road_cls)))
    out.append('  var byId = {};')
    out.append('  var kmById = %s;' % json.dumps(
        {STATION_META[nm]['id']: st_km[nm] for nm in st_km if nm in STATION_META}))
    out.append('  stations.forEach(function (s) { byId[s.id] = s; s.km = kmById[s.id] || 0; });')
    out.append('  var svc = {};')
    out.append('  lines.forEach(function (l) { l.services.forEach(function (s) {')
    out.append('    s.lineKey = l.key; s.color = l.color; svc[s.key] = s;')
    out.append('  }); });')
    out.append('  return {')
    out.append('    generated: %s,' % json.dumps('by tools/build-data.py, 2026-09-12 (OSM + 百度百科)'))
    out.append('    unitsPerKm: %g, lines: lines, stations: stations, byId: byId, services: svc,' % UNITS_PER_KM)
    out.append('    tracks: tracks, water: water, roads: roads,')
    out.append('    mapBox: {x0:%g,y0:%g,x1:%g,y1:%g},' % (map_x0, map_y0, map_x1, map_y1))
    out.append('    junctionId: %s, lineColors: %s' % (json.dumps('sihe'), json.dumps(LINE_COLORS)))
    out.append('  };')
    out.append('})();')
    out.append('')

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    size = len('\n'.join(out).encode('utf-8'))
    n_out_road_pts = sum(len(p) for p in road_pts)
    print('== 输出 %s（%.1f KB）：%d 站 / %d 条轨道 / %d 条河流 / %d 个湖泊 / %d 段道路(%d 点)'
          % (out_path, size / 1024.0, len(station_js), len(tracks), len(rivers), len(lakes),
             len(road_pts), n_out_road_pts))
    print('   地图范围 units: x %.0f..%.0f  y %.0f..%.0f' % (map_x0, map_x1, map_y0, map_y1))


if __name__ == '__main__':
    main()
