/* =============================================================================
 * app.js - 成都地铁 1 号线：示意线路图 + 3 车厢列车运行模拟
 * 纯 vanilla JS（无依赖、无构建）。依赖 data.js 暴露的 window.METRO。
 *
 * 主要模块：
 *   1. 路径采样（Catmull-Rom 平滑曲线 -> 弧长参数化，供列车沿线路行驶）
 *   2. 底图装饰（网格 / 街区 / 道路 / 河流 / 公园）
 *   3. 线路、车站、站名标签（防重叠）
 *   4. 3 车厢列车（按弧长排布，沿切线方向贴合线路）
 *   5. 运行状态机（加速-巡航-制动-停站-开关门-折返-交路切换-目标站导航）
 *   6. 视图（Pointer Events 平移/捏合/双击，自适应缩放与边界约束）
 * ========================================================================== */
(function () {
  'use strict';

  var M = window.METRO;
  var NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ 配置 */
  var CFG = {
    vmax: 60,              // 巡航速度 km/h（线路设计最高 80 km/h）
    accel: 0.75,           // 加速度 m/s^2
    decel: 0.9,            // 制动减速度 m/s^2
    openT: 1.2,            // 开门动画 s
    holdT: 7.0,            // 开门保持（上下客）s
    closeT: 1.2,           // 关门动画 s
    readyT: 0.6,           // 关门后确认 s（合计停站 10.0s）
    reverseT: 12,          // 终点站折返 s
    cars: 8,
    carLen: 9,             // 车厢长度（地图单位，示意夸张）
    carGap: 1.2,           // 车厢间隙
    carHW: 5.0,            // 车厢半宽
    platHalf: 20,          // 站台长度的一半（地图单位）
    platHW: 8.5,           // 站台半宽
    stub: 120,             // 端点站外的折返线长度（地图单位，要能容下整列车）
    tapRadius: 30,         // 站点命中半径（屏幕 px，直径 60 >= 44）
    tapMove: 13,           // 判定为拖动的最小位移（屏幕 px）
    tapMs: 2500,           // 静止按压超过该时长仍算选中（只是手感提示，不做拒绝）
    dblMs: 320,            // 双击间隔
    fadeLabels: 0.60       // 低于该缩放只显示重点站名
  };

  var VIEW_MARGIN = { x: 210, y: 205 };   // 适配视图时线路四周的留白（地图单位，给 HUD/图例留位置）

  /* 线路标志色（data.js 提供则优先用 data.js 的） */
  var LINE_COLORS = (function () {
    var m = {};
    var src = M.lineColors || {};
    Object.keys(src).forEach(function (k) { m[k] = src[k]; });
    (M.lines || []).forEach(function (l) { if (l && l.key) m[l.key] = l.color; });
    if (!m['1']) m['1'] = '#0d6cb5';
    return m;
  })();

  /* --------------------------------------------------------------- 运行时状态 */
  /* 全局（与列车无关）的运行/视图开关 */
  var ui = { paused: false, mult: 1, follow: false };

  /* 每列车的运行状态；state 始终指向「当前控制的那列车」（trains[activeIdx]） */
  var trains = [];
  var activeIdx = 0;
  var state = null;

  function newTrain(homeRoute) {
    var r = ROUTES[homeRoute];
    return {
      homeRoute: homeRoute, routeKey: homeRoute, dir: 1,
      posKm: r.kmAt[0], v: 0, phase: 'dwell', phaseT: 0,
      doorPhase: 'opening', door: 0,
      curId: r.ids[0], nextIdx: 1,
      target: null, odometer: 0, eta: null, etaStops: 0,
      lastTargetToast: null,
      silent: false,                                     // 只有仿真副本才是 silent（它同时用于“不弹 toast”和“不报站”）
      aOpened: true, aClosing: true, aDepart: true      // 始发站不报站
    };
  }

  function setActive(i) {
    if (i < 0 || i >= trains.length) return false;
    activeIdx = i;
    state = trains[i];
    return true;
  }

  /* 每列车默认交路：各线路的第一条交路（需要等 ROUTES 建好，所以在 initTrains 里算） */
  function trainHomeRoutes() {
    var keys = Object.keys(ROUTES);
    return keys.filter(function (k) {
      return !keys.some(function (k2) {
        return k2 !== k && ROUTES[k2].lineKey === ROUTES[k].lineKey && keys.indexOf(k2) < keys.indexOf(k);
      });
    });
  }

  function initTrains() {
    trains = trainHomeRoutes().map(function (k) { return newTrain(k); });
    setActive(0);
  }

  function resetTrain(tr, keepTarget) {
    var tgt = keepTarget ? tr.target : null;
    var r = ROUTES[tr.homeRoute];
    tr.routeKey = tr.homeRoute;
    tr.dir = 1;
    tr.posKm = r.kmAt[0];
    tr.v = 0;
    tr.phase = 'dwell';
    tr.phaseT = 0;
    tr.doorPhase = 'opening';
    tr.door = 0;
    tr.curId = r.ids[0];
    tr.nextIdx = 1;
    tr.odometer = 0;
    tr.target = tgt;
    tr.eta = null; tr.etaStops = 0;
    tr.lastTargetToast = null;
    tr.silent = false;
    tr.aOpened = true; tr.aClosing = true; tr.aDepart = true;   // 起点站不报站
  }

  function resetAllTrains() {
    trains.forEach(function (tr) { resetTrain(tr, false); });
    etaCache = [];
    if (world) world.style.setProperty('--line', ROUTES[state.routeKey].color);
    recomputeEta();
  }

  var selected = null;          // 面板里选中的站点 id
  var view = { k: 1, tx: 0, ty: 0, fitted: true };
  var stage = { w: 800, h: 600 };
  var ready = false;
  var SELFTEST_MODE = /[?&]selftest/.test(location.search);   // 自检模式：降低重绘频率，加快无头运行
  var renderAcc = 0;

  /* --------------------------------------------------------------- 工具函数 */
  function $(id) { return document.getElementById(id); }
  function svg(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function f1(n) { return Math.round(n * 10) / 10; }
  function f2(n) { return Math.round(n * 100) / 100; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }  function fmtKm(km) { return km.toFixed(2) + ' km'; }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m >= 60) return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
    if (m > 0) return m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒';
    return s + ' 秒';
  }
  /* 种子随机，保证底图每次一致 */
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* =========================================================== 1. 路径采样 */
  /* Catmull-Rom（转三次贝塞尔）经过所有顶点，再细采样成折线表并累计弧长。 */
  /* 真实轨道折线：直接使用 OSM 采点（不再做样条插值，保持形状与里程准确） */
  function buildSection(pts) {
    var samples = pts.map(function (p) { return { x: p.x, y: p.y }; });
    var cum = [0];
    for (var i = 1; i < samples.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    }
    return { pts: pts, samples: samples, cum: cum, length: cum[samples.length - 1] };
  }

  /* 轨道折线（不含折返线；折返线在交路两端统一加） */
  function trackFrom(xy) {
    var pts = (xy || []).map(function (p) { return { id: null, x: p[0], y: p[1] }; });
    return buildSection(pts);
  }

  var TRACKS = {};
  Object.keys(M.tracks || {}).forEach(function (key) { TRACKS[key] = trackFrom(M.tracks[key]); });

  /* 点到折线最近点：返回弧长 s 与距离 d */
  function projectOnPolyline(route, x, y) {
    var best = { s: 0, d: Infinity }, acc = 0;
    for (var i = 1; i < route.samples.length; i++) {
      var a = route.samples[i - 1], b = route.samples[i];
      var dx = b.x - a.x, dy = b.y - a.y, seg = Math.hypot(dx, dy);
      var t = seg ? clamp(((x - a.x) * dx + (y - a.y) * dy) / (seg * seg), 0, 1) : 0;
      var d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
      if (d < best.d) best = { s: acc + t * seg, d: d };
      acc += seg;
    }
    return best;
  }

  /* 交路 = 轨道段拼接；站点投影到轨道上得到弧长（里程 = 弧长 / unitsPerKm，即真实轨道里程） */
  function buildRoute(svc) {
    var samples = [], i, k;
    (svc.tracks || []).forEach(function (tk, ti) {
      var tr = TRACKS[tk];
      if (!tr) return;
      var from = ti === 0 ? 0 : 1;        // 段与段的连接点只取一次
      for (k = from; k < tr.samples.length; k++) samples.push(tr.samples[k]);
    });
    /* 交路两端各加一段折返线延长，使列车可整列停在端点站 */
    if (samples.length > 1) {
      var a0 = samples[0], a1 = samples[1];
      var dx0 = a1.x - a0.x, dy0 = a1.y - a0.y, L0 = Math.hypot(dx0, dy0) || 1;
      samples.unshift({ x: a0.x - dx0 / L0 * CFG.stub, y: a0.y - dy0 / L0 * CFG.stub });
      var z0 = samples[samples.length - 1], z1 = samples[samples.length - 2];
      var ex0 = z0.x - z1.x, ey0 = z0.y - z1.y, EL0 = Math.hypot(ex0, ey0) || 1;
      samples.push({ x: z0.x + ex0 / EL0 * CFG.stub, y: z0.y + ey0 / EL0 * CFG.stub });
    }
    var cum = [0];
    for (i = 1; i < samples.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    }
    var route = {
      key: svc.key, label: svc.label, lineKey: svc.lineKey, color: svc.color,
      samples: samples, cum: cum, length: cum[cum.length - 1],
      ids: [], mapAt: [], kmAt: [], projErr: 0
    };
    (svc.stationIds || []).forEach(function (id) {
      var st = M.byId[id];
      if (!st) return;
      var r = projectOnPolyline(route, st.x, st.y);
      route.ids.push(id);
      route.mapAt.push(r.s);
      route.kmAt.push(Math.max(0, r.s - CFG.stub) / M.unitsPerKm);
      route.projErr = Math.max(route.projErr, r.d);
    });
    route.kmLength = route.kmAt[route.kmAt.length - 1];
    route.terminus = route.ids[route.ids.length - 1];
    route.origin = route.ids[0];
    return route;
  }

  var ROUTES = {};
  (M.lines || []).forEach(function (line) {
    line.services.forEach(function (svc) { ROUTES[svc.key] = buildRoute(svc); });
  });
  var ROUTE_KEYS = Object.keys(ROUTES);
  var DEFAULT_ROUTE = ROUTE_KEYS[0];
  var LINES = (M.lines || []).map(function (l) { return { key: l.key, name: l.name, short: l.short, color: l.color }; });
  var LINE_BY_KEY = {};
  LINES.forEach(function (l) { LINE_BY_KEY[l.key] = l; });

  /* 同线路多条交路的“分叉站” = 两条交路站序的最长公共前缀末站（1 号线为四河） */
  var LINE_SWITCH = {};
  (M.lines || []).forEach(function (line) {
    if (line.services.length < 2) return;
    var a = ROUTES[line.services[0].key].ids, b = ROUTES[line.services[1].key].ids, n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    if (n > 0) LINE_SWITCH[line.key] = a[n - 1];
  });
  var JUNCTION_ID = LINE_SWITCH['1'] || 'sihe';

  function servicesContaining(id) {
    var out = [];
    ROUTE_KEYS.forEach(function (k) { if (ROUTES[k].ids.indexOf(id) >= 0) out.push(k); });
    return out;
  }
  function stationLineKey(id) {
    var c = servicesContaining(id);
    return c.length ? ROUTES[c[0]].lineKey : null;
  }
  /* 目标站应由哪条交路服务（优先与当前交路同线路） */
  function serviceForStation(id, curKey) {
    if (curKey && ROUTES[curKey] && ROUTES[curKey].ids.indexOf(id) >= 0) return curKey;
    var cands = servicesContaining(id);
    if (!cands.length) return null;
    for (var i = 0; i < cands.length; i++) {
      if (ROUTES[cands[i]].lineKey === (ROUTES[curKey] ? ROUTES[curKey].lineKey : null)) return cands[i];
    }
    return cands[0];
  }

  /* 弧长 -> 点 / 切线 */
  function pointAt(route, s) {
    var cum = route.cum;
    s = clamp(s, 0, route.length);
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    var span = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / span;
    var a = route.samples[lo], b = route.samples[hi];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  function angleAt(route, s) {
    var a = pointAt(route, s - 1.2), b = pointAt(route, s + 1.2);
    return Math.atan2(b.y - a.y, b.x - a.x);
  }
  /* 里程(km) <-> 路径弧长(地图单位) 分段线性映射 */
  function kmToMap(route, km) {
    var a = route.kmAt, m = route.mapAt;
    km = clamp(km, 0, route.kmLength);
    var lo = 0, hi = a.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (a[mid] <= km) lo = mid; else hi = mid; }
    var span = a[hi] - a[lo] || 1;
    return m[lo] + (km - a[lo]) / span * (m[hi] - m[lo]);
  }
  /* 沿路径生成“带状”轮廓（中心线两侧各 offset±halfW），用于车厢与站台 */
  function bandPath(route, sFront, sRear, off, halfW, segs, prof) {
    var left = [], right = [], k, u, s, p, ang, nx, ny, w, o;
    segs = segs || 12;
    for (k = 0; k <= segs; k++) {
      u = k / segs;
      s = sFront + (sRear - sFront) * u;
      p = pointAt(route, s); ang = angleAt(route, s);
      nx = -Math.sin(ang); ny = Math.cos(ang);
      w = halfW * (prof ? prof(u) : 1);
      o = off;
      left.push([p.x + nx * (o + w), p.y + ny * (o + w)]);
      right.push([p.x + nx * (o - w), p.y + ny * (o - w)]);
    }
    var d = 'M' + f1(left[0][0]) + ' ' + f1(left[0][1]);
    for (k = 1; k <= segs; k++) d += 'L' + f1(left[k][0]) + ' ' + f1(left[k][1]);
    for (k = segs; k >= 0; k--) d += 'L' + f1(right[k][0]) + ' ' + f1(right[k][1]);
    return d + 'Z';
  }

  /* ================================================ 2. 底图装饰（OSM 真实地理） */
  var MAPBOX = (function () {
    var b = M.mapBox || { x0: 0, y0: 0, x1: 1400, y1: 2000 }, pad = 420;
    return { x: b.x0 - pad, y: b.y0 - pad, w: (b.x1 - b.x0) + pad * 2, h: (b.y1 - b.y0) + pad * 2 };
  })();

  /* 水系注记：[名称, dx, dy] */
  var WATER_LABELS = [['锦江', 0, 0], ['沙河', 16, -6], ['府河', -14, 10], ['清水河', 0, 0],
    ['兴隆湖', 0, 0], ['麓湖', 0, 0], ['升仙湖', 0, -16], ['北湖', 0, 0], ['青龙湖', 0, 0]];

  function buildBackground(world) {
    var rnd = mulberry(20260318);
    var g = svg('g', { id: 'bg' }, world);
    var i;

    /* 城市纹理 pattern */
    var defs = svg('defs', null, g);
    var pat = svg('pattern', { id: 'cityTex', width: 96, height: 96, patternUnits: 'userSpaceOnUse' }, defs);
    for (i = 0; i < 7; i++) {
      var bw = 14 + rnd() * 26, bh = 11 + rnd() * 20;
      svg('rect', {
        x: f1(rnd() * (96 - bw)), y: f1(rnd() * (96 - bh)),
        width: f1(bw), height: f1(bh), rx: 2.5,
        fill: i % 3 === 0 ? '#e9e4d8' : '#eee9dd'
      }, pat);
    }
    svg('rect', { x: f1(MAPBOX.x), y: f1(MAPBOX.y), width: f1(MAPBOX.w), height: f1(MAPBOX.h), fill: 'url(#cityTex)' }, g);

    /* 网格 */
    var grid = svg('g', null, g);
    for (i = Math.ceil(MAPBOX.x / 250) * 250; i < MAPBOX.x + MAPBOX.w; i += 250) {
      svg('line', { class: 'bg-grid', x1: f1(i), y1: f1(MAPBOX.y), x2: f1(i), y2: f1(MAPBOX.y + MAPBOX.h) }, grid);
    }
    for (i = Math.ceil(MAPBOX.y / 250) * 250; i < MAPBOX.y + MAPBOX.h; i += 250) {
      svg('line', { class: 'bg-grid', x1: f1(MAPBOX.x), y1: f1(i), x2: f1(MAPBOX.x + MAPBOX.w), y2: f1(i) }, grid);
    }

    /* 道路：OSM motorway / trunk / primary（装饰层，只求城市骨架观感） */
    var roads = svg('g', { id: 'roads' }, g);
    var RW = { motorway: 7, trunk: 5.5, primary: 4 };
    (M.roads || []).forEach(function (rd) {
      if (!rd.pts || rd.pts.length < 2) return;
      var d = 'M' + rd.pts.map(function (p) { return f1(p[0]) + ' ' + f1(p[1]); }).join('L');
      var w = RW[rd.c] || 4.5;
      svg('path', { class: 'bg-road-casing', d: d, 'stroke-width': w + 2.6 }, roads);
      svg('path', { class: 'bg-road', d: d, 'stroke-width': w }, roads);
    });

    /* 河流（OSM waterway）：锦江/府河/南河画粗一点 */
    var water = svg('g', { id: 'water' }, g);
    (M.water && M.water.rivers ? M.water.rivers : []).forEach(function (rv) {
      if (!rv.pts || rv.pts.length < 2) return;
      var d = 'M' + rv.pts.map(function (p) { return f1(p[0]) + ' ' + f1(p[1]); }).join('L');
      var big = /锦江|府河|南河/.test(rv.name);
      var path = svg('path', { class: 'bg-water', d: d }, water);
      path.style.strokeWidth = (big ? 22 : 11) + 'px';
    });
    /* 湖泊（OSM natural=water 多边形） */
    (M.water && M.water.lakes ? M.water.lakes : []).forEach(function (lk) {
      if (!lk.pts || lk.pts.length < 3) return;
      var d = 'M' + lk.pts.map(function (p) { return f1(p[0]) + ' ' + f1(p[1]); }).join('L') + 'Z';
      svg('path', { class: 'bg-lake', d: d }, water);
    });

    /* 水系注记：取几何代表点，河流沿切线方向旋转 */
    var wlab = svg('g', null, g);
    WATER_LABELS.forEach(function (t) {
      var nm = t[0], geo = null, isRiver = false;
      (M.water.rivers || []).forEach(function (r) { if (r.name === nm) { geo = r.pts; isRiver = true; } });
      (M.water.lakes || []).forEach(function (l) { if (l.name === nm) geo = l.pts; });
      if (!geo || geo.length < 3) return;
      var idx = isRiver ? Math.floor(geo.length * 0.45) : Math.floor(geo.length / 2);
      var p = geo[idx], x = p[0] + t[1], y = p[1] + t[2];
      var el = svg('text', { class: 'bg-label', x: f1(x), y: f1(y), 'text-anchor': 'middle' }, wlab);
      if (isRiver) {
        var q = geo[Math.min(geo.length - 1, idx + 3)] || geo[idx - 1] || p;
        var ang = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        el.setAttribute('transform', 'rotate(' + f1(clamp(ang, -70, 70)) + ' ' + f1(x) + ' ' + f1(y) + ')');
      }
      el.textContent = nm;
      bgLabels.push(el);
    });
  }

  /* ==================================================== 3. 线路 / 车站 / 标签 */
  var world, railLayers = {}, stationEls = {}, labelEls = [], labelScale = 1, railGroup = null;
  var labelBoxes = [], bgLabels = [];

  function buildRail() {
    var g = svg('g', { id: 'rails' }, world);
    railGroup = g;
    var order = [];
    (M.lines || []).forEach(function (line) {
      var seen = {};
      line.services.forEach(function (s) {
        (s.tracks || []).forEach(function (tk) {
          if (!seen[tk] && TRACKS[tk]) { seen[tk] = 1; order.push({ k: tk, color: line.color }); }
        });
      });
    });
    order.forEach(function (o) {
      var tr = TRACKS[o.k];
      var d = 'M' + tr.samples.map(function (p) { return f1(p.x) + ' ' + f1(p.y); }).join('L');
      svg('path', { class: 'rail-bed', d: d, 'stroke-width': 15 }, g);
      var path = svg('path', { class: 'rail', d: d, 'stroke-width': 10.5 }, g);
      path.style.stroke = o.color;          // CSS 里的 .rail 用 var(--line)，这里按线路覆盖
    });
    /* 分叉站标记（同线路多条交路的换乘点，如 1 号线四河） */
    Object.keys(LINE_SWITCH).forEach(function (lk) {
      var st = M.byId[LINE_SWITCH[lk]];
      if (!st) return;
      var c = svg('circle', { class: 'junction', cx: f1(st.x), cy: f1(st.y), r: 4.2 }, g);
      c.style.stroke = LINE_BY_KEY[lk].color;
    });
  }

  function buildStations() {
    var gPlat = svg('g', { id: 'platforms' }, world);
    var gSt = svg('g', { id: 'stations' }, world);
    if (railGroup && railGroup.parentNode === world) world.insertBefore(gPlat, railGroup);   // 站台在轨道下方，只从两侧露出
    M.stations.forEach(function (st) {
      servicesContaining(st.id).forEach(function (k) {
        var i = ROUTES[k].ids.indexOf(st.id);
        svg('path', {
          class: 'platform', 'data-st': st.id,
          d: bandPath(ROUTES[k], ROUTES[k].mapAt[i] + CFG.platHalf, ROUTES[k].mapAt[i] - CFG.platHalf, 0, CFG.platHW, 10)
        }, gPlat);
      });
      var big = (st.lines && st.lines.length > 1) || (st.tr && st.tr.length);
      var r = big ? 6.4 : (st.term ? 6.0 : 5.0);
      var ln = (st.lines && st.lines[0]) || '1';
      var col = (LINE_BY_KEY[ln] || { color: M.lineColors['1'] }).color;
      var dotG = svg('g', { 'data-st': st.id }, gSt);
      if (big) {
        var c1 = svg('circle', { class: 'st ring', cx: f1(st.x), cy: f1(st.y), r: r }, dotG);
        c1.style.stroke = col;
        var c2 = svg('circle', { class: 'st ring2', cx: f1(st.x), cy: f1(st.y), r: r + 3.4 }, dotG);
        c2.style.stroke = col;
      } else {
        var dot = svg('circle', { class: 'st' + (st.term ? ' term' : ''), cx: f1(st.x), cy: f1(st.y), r: r }, dotG);
        if (st.term) dot.style.fill = col; else dot.style.stroke = col;
        if (st.noStop) { dot.style.fill = '#fff'; dot.style.strokeDasharray = '2.6 2.6'; }
      }
      stationEls[st.id] = dotG;
    });
  }

  /* 站点在交路上的弧长位置 / 里程 */
  function stationMapS(id, key) {
    var k = key || serviceForStation(id, state.routeKey) || DEFAULT_ROUTE;
    var i = ROUTES[k].ids.indexOf(id);
    return i >= 0 ? ROUTES[k].mapAt[i] : 0;
  }
  function stationKm(id) {
    var k = serviceForStation(id, state.routeKey) || DEFAULT_ROUTE;
    var i = ROUTES[k].ids.indexOf(id);
    return i >= 0 ? ROUTES[k].kmAt[i] : ((M.byId[id] && M.byId[id].km) || 0);
  }
  function routeKeyOf(id) { return serviceForStation(id, state.routeKey); }

  function buildLabels() {
    var g = svg('g', { id: 'labels' }, world);
    labelEls = [];
    M.stations.forEach(function (st, idx) {
      var pref = (idx % 2 === 0) ? 1 : -1;
      var grp = svg('g', { class: 'lbl-g', 'data-st': st.id }, g);
      var zh = svg('text', { class: 'lbl-zh', y: -2 }, grp);
      zh.textContent = st.zh;
      var en = svg('text', { class: 'lbl-en', y: 10 }, grp);
      en.textContent = st.en;
      var pills = null, pillsH = 0;
      if (st.tr.length) {
        pills = svg('g', { class: 'lbl-tr' }, grp);
        var x = 0;
        st.tr.forEach(function (t) {
          svg('rect', { class: 'lbl-tr-bg', x: x, y: 14, width: 13, height: 12, rx: 3.5 }, pills);
          var txt = svg('text', { x: x + 6.5, y: 23, 'text-anchor': 'middle' }, pills);
          txt.textContent = t;
          x += 15;
        });
        pillsH = 16;
      }
      var L = {
        st: st, g: grp, zh: zh, en: en, pills: pills, pref: pref, vis: true,
        key: st.tr.length > 0 || st.term || !!st.junction, w: 0, h: 31 + pillsH
      };
      labelEls.push(L);
    });
  }

  function applyLabelSide(L, side, dy, rot) {
    var x = side * 15, anchor = side > 0 ? 'start' : 'end';
    L.zh.setAttribute('x', x); L.zh.setAttribute('text-anchor', anchor);
    L.en.setAttribute('x', x); L.en.setAttribute('text-anchor', anchor);
    if (L.pills) L.pills.setAttribute('transform', 'translate(' + (side > 0 ? x : x - 45) + ',0)');
    L.side = side; L.dy = dy || 0; L.rot = rot || 0;
    var s = labelScale;
    var tr = 'translate(' + f2(L.st.x) + ',' + f2(L.st.y + L.dy) + ') scale(' + f2(s) + ')';
    if (rot) tr += ' rotate(' + rot + ')';
    L.g.setAttribute('transform', tr);
  }

  /* 把 getBBox 结果按当前 transform 换算成地图坐标矩形 */
  function boxFromBBox(L, bb) {
    var s = labelScale, r = (L.rot || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    var corners = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]];
    var xs = [], ys = [];
    corners.forEach(function (p) {
      var x = p[0] * s, y = p[1] * s;
      var rx = x * cs - y * sn, ry = x * sn + y * cs;
      xs.push(L.st.x + rx); ys.push(L.st.y + L.dy + ry);
    });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, stId: L.st.id };
  }

  function layoutLabels() {
    labelBoxes = [];
    var vis = labelEls.filter(function (L) { return L.vis; });
    var order = vis.slice().sort(function (a, b) {
      if (a.key !== b.key) return a.key ? -1 : 1;
      return a.st.y - b.st.y;
    });
    order.forEach(function (L) {
      var tries = [
        [L.pref, 0, 0], [-L.pref, 0, 0],
        [L.pref, 15, 0], [-L.pref, 15, 0],
        [L.pref, -15, 0], [-L.pref, -15, 0],
        [L.pref, 30, 0], [-L.pref, 30, 0],
        [L.pref, -30, 0], [-L.pref, -30, 0],
        [L.pref, 0, 0], [-L.pref, 0, 0]
      ];
      var last = tries.length - 2;
      var best = null, bestPen = Infinity;
      for (var i = 0; i < tries.length; i++) {
        var rot = i >= last ? (i === last ? -46 : 46) : 0;
        applyLabelSide(L, tries[i][0], tries[i][1], rot);
        var rect = boxFromBBox(L, L.g.getBBox());
        var pen = 0;
        for (var k = 0; k < labelBoxes.length; k++) pen += overlapArea(rect, labelBoxes[k]);
        pen += dotPenalty(rect, labelBoxes);
        if (pen < bestPen) { bestPen = pen; best = { side: tries[i][0], dy: tries[i][1], rot: rot, rect: rect }; }
        if (pen <= 0) break;
      }
      applyLabelSide(L, best.side, best.dy, best.rot);
      var rect2 = best.rect;
      rect2.pen = bestPen;
      labelBoxes.push(rect2);
    });
  }
  function overlapArea(a, b) {
    var dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return (dx > 0 && dy > 0) ? dx * dy : 0;
  }
  /* 标签压到别的站点圆点要罚分，避免遮住车站 */
  function dotPenalty(rect, boxes) {
    var p = 0;
    for (var i = 0; i < boxes.length; i++) {
      var st = M.byId[boxes[i].stId];
      if (!st || st.id === rect.stId) continue;
      if (overlapArea(rect, { x: st.x - 10, y: st.y - 10, w: 20, h: 20 })) p += 900;
    }
    return p;
  }

  function updateLabelScale() {
    labelScale = clamp(1 / view.k, 0.34, 2.0);
    var all = view.k >= CFG.fadeLabels;
    labelEls.forEach(function (L) {
      var vis = all || L.key;
      L.vis = vis;
      L.g.classList.toggle('hide', !vis);
      L.g.classList.toggle('dim', all && !L.key && view.k < 0.9);
    });
    /* 底图注记（河流/湖泊）保持屏幕字号恒定 */
    bgLabels.forEach(function (t) { t.setAttribute('font-size', f2(clamp(11 / view.k, 3, 46))); });
    layoutLabels();
  }

  /* ============================================================= 4. 列车 */
  var trainGroups = [];

  /* 每列车一个 group（3 节车厢）；色带颜色由 group 上的 --line 决定 */
  function buildTrains() {
    var wrap = svg('g', { id: 'trains' }, world);
    trains.forEach(function (tr, ti) {
      var g = svg('g', { class: 'train', 'data-train': ti }, wrap);
      g.style.setProperty('--line', ROUTES[tr.routeKey].color);
      var shadow = svg('g', { class: 'train-shadow', transform: 'translate(2.2,3.2)' }, g);
      var halo = svg('g', { class: 'train-halo' }, g);
      halo.style.setProperty('--line', ROUTES[tr.routeKey].color);
      var sel = svg('circle', { class: 'train-sel', r: 9 }, g);
      var cars = svg('g', null, g);
      var els = [];
      for (var i = 0; i < CFG.cars; i++) {
        var car = svg('g', null, cars);
        var bodyCls = 'car-body' + (i === 0 ? ' head' : '');
        els.push({
          halo: svg('path', null, halo),
          shadow: svg('path', null, shadow),
          body: svg('path', { class: bodyCls }, car),
          nose: i === 0 ? svg('path', { class: 'car-nose' }, car) : null,
          stripe: svg('path', { class: 'car-stripe' }, car),
          win: svg('path', { class: 'car-win' }, car),
          door: svg('path', { class: 'car-door-leaf' }, car),
          gap: svg('path', { class: 'car-gap' }, car)
        });
      }
      trainGroups.push({ g: g, sel: sel, els: els });
    });
  }

  function noseProfile(i) {
    if (i === 0) return function (u) { return u < 0.16 ? 0.5 + 0.5 * (u / 0.16) : 1; };
    return function () { return 1; };
  }
  function tailProfile(i, total) {
    if (i === total - 1) return function (u) { return u > 0.9 ? 1 - 0.2 * ((u - 0.9) / 0.1) : 1; };
    return function () { return 1; };
  }

  /* 逐列车绘制（贴在各自线路上） */
  function renderTrains() {
    var total = CFG.cars;
    trains.forEach(function (tr, ti) {
      var grp = trainGroups[ti];
      if (!grp) return;
      var route = ROUTES[tr.routeKey];
      var sHead = kmToMap(route, tr.posKm);
      var dir = tr.dir;
      grp.g.classList.toggle('active', ti === activeIdx);
      for (var i = 0; i < total; i++) {
        var fS = sHead - dir * i * (CFG.carLen + CFG.carGap);
        var rS = fS - dir * CFG.carLen;
        var prof = function (u) { return noseProfile(i)(u) * tailProfile(i, total)(u); };
        var el = grp.els[i];
        el.body.setAttribute('d', bandPath(route, fS, rS, 0, CFG.carHW, 14, prof));
        el.halo.setAttribute('d', bandPath(route, fS, rS, 0, CFG.carHW * 1.55, 10, prof));
        el.shadow.setAttribute('d', bandPath(route, fS, rS, 0, CFG.carHW * 1.12, 12, prof));
        el.stripe.setAttribute('d', bandPath(route, fS + dir * -CFG.carLen * 0.1, rS + dir * CFG.carLen * 0.1, 0, CFG.carHW * 0.17, 8));
        var winHalf = CFG.carLen * 0.115;
        var wins = '';
        [0.30, 0.45, 0.60, 0.74].forEach(function (u) {
          var c = fS + (rS - fS) * u;
          wins += bandPath(route, c + winHalf, c - winHalf, CFG.carHW * 0.62, CFG.carHW * 0.17, 3) + ' ';
          wins += bandPath(route, c + winHalf, c - winHalf, -CFG.carHW * 0.62, CFG.carHW * 0.17, 3) + ' ';
        });
        el.win.setAttribute('d', wins);
        var doorHalf = CFG.carLen * 0.093;
        var dOpen = tr.door * CFG.carLen * 0.083;
        var doors = '', gaps = '';
        [0.17, 0.83].forEach(function (u) {
          var c = fS + (rS - fS) * u;
          var l1 = c - doorHalf - dOpen, l2 = c - dOpen;
          var r1 = c + dOpen, r2 = c + doorHalf + dOpen;
          [[l1, l2], [r1, r2]].forEach(function (seg) {
            doors += bandPath(route, seg[0], seg[1], CFG.carHW * 0.90, CFG.carHW * 0.24, 3) + ' ';
            doors += bandPath(route, seg[0], seg[1], -CFG.carHW * 0.90, CFG.carHW * 0.24, 3) + ' ';
          });
          if (dOpen > 0.05) gaps += bandPath(route, c + dOpen * 0.92, c - dOpen * 0.92, 0, CFG.carHW * 1.05, 3) + ' ';
        });
        el.door.setAttribute('d', doors);
        el.gap.setAttribute('d', gaps);
        if (el.nose) {
          var nc = fS + (rS - fS) * 0.055;
          el.nose.setAttribute('d', bandPath(route, fS + (rS - fS) * 0.02, nc, 0, CFG.carHW * 0.78, 4));
        }
      }
      /* 当前控制列车的选中指示（车头位置的小圆环） */
      var hp = pointAt(route, sHead);
      grp.sel.setAttribute('cx', f1(hp.x));
      grp.sel.setAttribute('cy', f1(hp.y));
      grp.sel.style.stroke = route.color;
      grp.sel.style.display = (ti === activeIdx) ? '' : 'none';
    });
  }

  /* 点到哪列车（车头/车厢中点 30px 内） */
  function hitTrain(p) {
    var best = -1, bestD = 30;
    trains.forEach(function (tr, ti) {
      var route = ROUTES[tr.routeKey];
      var sHead = kmToMap(route, tr.posKm);
      for (var i = 0; i < CFG.cars; i++) {
        var c = pointAt(route, sHead - tr.dir * (i * (CFG.carLen + CFG.carGap) + CFG.carLen / 2));
        var d = Math.hypot(c.x * view.k + view.tx - p.x, c.y * view.k + view.ty - p.y);
        if (d < bestD) { bestD = d; best = ti; }
      }
    });
    return best;
  }

  /* 下一站预测（用于强调圈与气泡） */
  function nextStopOf(tr) {
    var r = ROUTES[tr.routeKey];
    if (tr.phase === 'reverse') return tr.curId;
    var i = r.ids.indexOf(tr.curId);
    if (i < 0) return r.ids[0];
    if (tr.phase === 'run') return r.ids[tr.nextIdx];
    var j = i + tr.dir;
    if (j < 0 || j >= r.ids.length) return tr.curId;
    return r.ids[j];
  }

  /* 到下一站的剩余时间：用同一套状态机向前预演到「下一次到站」 */
  function legEta(tr) {
    if (tr.phase === 'reverse') return { sec: null, note: '折返换向', id: tr.curId };
    var sim = cloneTrainState(tr);
    var startPhase = sim.phase, dir0 = sim.dir, t = 0, guard = 0;
    while (guard++ < 5000) {
      stepTrain(sim, 0.25);
      t += 0.25;
      var stopped = (sim.phase === 'dwell' && sim.phaseT < 0.3);
      if (stopped && (startPhase !== 'dwell' || sim.dir !== dir0 || sim.curId !== tr.curId)) {
        return { sec: t, id: sim.curId, dir: sim.dir };
      }
      if (sim.dir !== dir0 && sim.phase === 'reverse') return { sec: t, note: '折返换向', id: sim.curId };
    }
    return { sec: null, note: '—', id: tr.curId };
  }

  /* ==================================== 列车强调显示（光晕 + 跟随标签贴片） */
  var pillLayer = null, pillEls = [];

  function buildTrainPills() {
    pillLayer = document.createElement('div');
    pillLayer.id = 'trainpills';
    pillLayer.className = 'tp-layer';
    $('stage').appendChild(pillLayer);
    trains.forEach(function (tr, ti) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tp';
      b.setAttribute('data-train', ti);
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (ti !== activeIdx) { setActive(ti); activateSideEffects(); }
        else toast('当前已是这列车：' + LINE_BY_KEY[ROUTES[state.routeKey].lineKey].short);
      });
      pillLayer.appendChild(b);
      pillEls.push(b);
    });
  }

  function updateTrainPills() {
    trains.forEach(function (tr, ti) {
      var b = pillEls[ti];
      if (!b) return;
      var line = LINE_BY_KEY[ROUTES[tr.routeKey].lineKey];
      var nx = ROUTES[tr.routeKey].ids[tr.nextIdx];
      var state_txt = tr.phase === 'reverse' ? '折返中'
        : tr.phase === 'dwell' ? (tr.doorPhase === 'open' ? '开门中' : tr.doorPhase === 'opening' ? '开门中' : tr.doorPhase === 'closing' ? '关门中' : '待发车')
        : (tr.v >= CFG.vmax - 0.5 ? '巡航' : tr.braking ? '减速' : '加速') + ' ' + tr.v.toFixed(0) + 'km/h';
      var sig = line.short + '|' + state_txt + '|' + (ti === activeIdx);
      if (b.__sig !== sig) {
        b.__sig = sig;
        b.className = 'tp' + (ti === activeIdx ? ' on' : '');
        b.innerHTML = '<span class="tp-badge" style="background:' + line.color + '">' + (ti === activeIdx ? '▶ ' : '') +
          line.short + '</span><b>' + state_txt + '</b>';
        b.title = '点一下切换为当前控制列车';
      }
    });
  }

  /* 跟随列车头部放置（放在车头上方；与到站气泡一起避让） */
  function placeTrainPills(placed) {
    trains.forEach(function (tr, ti) {
      var b = pillEls[ti];
      if (!b) return;
      var route = ROUTES[tr.routeKey];
      var sHead = kmToMap(route, tr.posKm);
      var hp = pointAt(route, sHead);
      var w = b.offsetWidth || 90, h = b.offsetHeight || 26;
      var x = hp.x * view.k + view.tx - w / 2;
      var y = hp.y * view.k + view.ty - (CFG.carHW * view.k + 16 + h) * 0.55;
      x = clamp(x, 6, Math.max(6, stage.w - w - 6));
      y = clamp(y, 6, Math.max(6, stage.h - h - 6));
      if (placed) {
        /* 注意：必须限定尝试次数 —— 如果气泡被舞台边缘钉住，“重新扫描”会变成死循环把页面卡死 */
        var guard = 0;
        for (var k = 0; k < placed.length && guard < 24; k++) {
          var q = placed[k];
          if (x < q.x + q.w + 4 && x + w + 4 > q.x && y < q.y + q.h + 4 && y + h + 4 > q.y) {
            y = clamp(q.y - h - 5, 6, Math.max(6, stage.h - h - 6));
            guard++;
            k = -1;
          }
        }
        placed.push({ x: x, y: y, w: w, h: h });
      }
      b.style.left = Math.round(x) + 'px';
      b.style.top = Math.round(y) + 'px';
    });
  }

  /* ==================================================== 下一站强调圈 + 到站气泡 */
  var markEls = [], bubbleLayer = null, bubbleWraps = {}, bubbleExpanded = {}, etaCache = [];

  function buildNextMarks() {
    var g = svg('g', { id: 'nextmarks' }, world);
    trains.forEach(function () {
      var halo = svg('circle', { class: 'next-halo', r: 16 }, g);
      var ring = svg('circle', { class: 'next-ring', r: 12 }, g);
      markEls.push({ halo: halo, ring: ring });
    });
    bubbleLayer = document.createElement('div');
    bubbleLayer.id = 'ntb';
    bubbleLayer.className = 'ntb-layer';
    $('stage').appendChild(bubbleLayer);
  }

  function updateNextMarks(dtRaw) {
    var now = performance.now();
    var groups = {};
    trains.forEach(function (tr, ti) {
      var mk = markEls[ti];
      if (!mk) return;
      var info = etaCache[ti];
      if (!info || now - info.at > 900) {
        info = legEta(tr);
        info.at = now;
        etaCache[ti] = info;
      }
      var sid = info.id || nextStopOf(tr);
      var st = M.byId[sid];
      if (!st) { mk.halo.style.display = mk.ring.style.display = 'none'; return; }
      var col = ROUTES[tr.routeKey].color;
      mk.halo.setAttribute('cx', f1(st.x)); mk.halo.setAttribute('cy', f1(st.y));
      mk.ring.setAttribute('cx', f1(st.x)); mk.ring.setAttribute('cy', f1(st.y));
      mk.halo.style.stroke = col; mk.halo.style.fill = col;
      mk.ring.style.stroke = col;
      mk.halo.style.display = mk.ring.style.display = '';
      mk.halo.classList.toggle('on', ti === activeIdx);
      (groups[sid] = groups[sid] || []).push({ ti: ti, sec: info.sec, note: info.note, tr: tr });
    });
    renderBubbles(groups);
    if (dtRaw === undefined) positionBubbles();
  }

  function renderBubbles(groups) {
    /* 清理不再需要的站点气泡 */
    Object.keys(bubbleWraps).forEach(function (sid) {
      if (!groups[sid]) {
        bubbleWraps[sid].remove();
        delete bubbleWraps[sid];
        delete bubbleExpanded[sid];
      }
    });
    Object.keys(groups).forEach(function (sid) {
      var list = groups[sid];
      var wrap = bubbleWraps[sid];
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'ntb-wrap';
        wrap.setAttribute('data-st', sid);
        bubbleLayer.appendChild(wrap);
        bubbleWraps[sid] = wrap;
      }
      var expanded = !!bubbleExpanded[sid];
      var multi = list.length > 1;
      wrap.classList.toggle('multi', multi);
      wrap.classList.toggle('expanded', expanded);
      var items = (multi && !expanded)
        ? [{ summary: true, list: list }]
        : list.map(function (x) { return x; });
      /* 重建内容（数量很少，直接重建最省心） */
      if (wrap.childNodes.length !== items.length || !wrap.__sig || wrap.__sig !== sigOf(items)) {
        wrap.innerHTML = '';
        items.forEach(function (it) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'ntb' + (it.summary ? ' ntb-sum' : '');
          if (it.summary) {
            var min = null;
            it.list.forEach(function (x) { if (x.sec != null && (min == null || x.sec < min)) min = x.sec; });
            b.innerHTML = '<span class="ntb-badge ntb-multi">' + it.list.map(function (x) {
              return ROUTES[x.tr.routeKey].lineKey;
            }).join('·') + '</span><b>' + it.list.length + ' 趟列车</b>' +
              '<i>' + (min != null ? fmtDur(min) : '—') + '</i>';
            b.title = '点一下展开全部到站气泡';
          } else {
            b.innerHTML = '<span class="ntb-badge" style="background:' + ROUTES[it.tr.routeKey].color + '">' +
              ROUTES[it.tr.routeKey].lineKey + '</span><b>' + (it.sec != null ? fmtDur(it.sec) : (it.note || '—')) + '</b>';
            b.title = ROUTES[it.tr.routeKey].label + ' · 点一下控制这列车';
          }
          b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (it.summary) { bubbleExpanded[sid] = true; updateNextMarks(); }
            else { setActive(it.ti); activateSideEffects(); }
          });
          wrap.appendChild(b);
        });
        wrap.__sig = sigOf(items);
      }
      var title = document.createElement('div');
      void title;
      wrap.setAttribute('data-name', M.byId[sid] ? M.byId[sid].zh : sid);
    });
  }
  function sigOf(items) {
    return items.map(function (it) {
      return it.summary ? 'S' + it.list.length : 'T' + it.ti + ':' + (it.sec != null ? Math.round(it.sec / 5) : it.note);
    }).join('|');
  }

  /* 气泡定位：列车标签先占位，气泡避开它们、HUD 与彼此，始终留在舞台内 */
  function positionBubbles() {
    var hudBox = $('hud') ? $('hud').getBoundingClientRect() : null;
    var hardBox = $('btnHardRefresh') ? $('btnHardRefresh').getBoundingClientRect() : null;
    var stageBox = $('stage').getBoundingClientRect();
    var placed = [];
    placeTrainPills(placed);
    function hits(box, x, y, w, h) {
      if (!box) return false;
      return !(x + w < box.left - stageBox.left || x > box.right - stageBox.left ||
        y + h < box.top - stageBox.top || y > box.bottom - stageBox.top);
    }
    Object.keys(bubbleWraps).forEach(function (sid) {
      var st = M.byId[sid], wrap = bubbleWraps[sid];
      if (!st || !wrap) return;
      var w = wrap.offsetWidth || 120, h = wrap.offsetHeight || 30;
      var cx = st.x * view.k + view.tx;
      var cy = st.y * view.k + view.ty;
      var x = clamp(cx - w / 2, 6, Math.max(6, stage.w - w - 6));
      var y = cy - (10 * Math.max(0.7, Math.min(1.6, view.k)) + 14) - h;
      /* 太靠近顶边或会被 HUD / 左上角刷新按钮盖住时，改放到站点下方 */
      var inHud = hits(hudBox, x, y, w, h) || hits(hardBox, x, y, w, h);
      if (y < 6 || inHud) {
        var y2 = cy + 14;
        if (hits(hudBox, x, y2, w, h) || hits(hardBox, x, y2, w, h)) {
          var below = Math.max(hudBox ? hudBox.bottom - stageBox.top : 0, hardBox ? hardBox.bottom - stageBox.top : 0);
          y2 = below + 6;
        }
        y = y2;
      }
      y = clamp(y, 6, Math.max(6, stage.h - h - 6));
      /* 与已放置气泡避免重叠（限定尝试次数，否则“重启扫描”可能死循环） */
      var guard = 0;
      for (var k = 0; k < placed.length && guard < 24; k++) {
        var q = placed[k];
        if (x < q.x + q.w + 4 && x + w + 4 > q.x && y < q.y + q.h + 4 && y + h + 4 > q.y) {
          y = clamp(q.y + q.h + 5, 6, Math.max(6, stage.h - h - 6));
          guard++;
          k = -1;
        }
      }
      placed.push({ x: x, y: y, w: w, h: h });
      wrap.style.left = Math.round(x) + 'px';
      wrap.style.top = Math.round(y) + 'px';
    });
  }

  function collapseBubbles() {
    var had = Object.keys(bubbleExpanded).length > 0;
    bubbleExpanded = {};
    if (had) updateNextMarks();
    return had;
  }

  /* 切换当前控制列车后的联动：面板、交路选择、跟随、悬浮窗 */
  function activateSideEffects() {
    if (world) world.style.setProperty('--line', ROUTES[state.routeKey].color);
    $('selRoute').value = state.routeKey;
    if (ui.follow) followStep(0, true);
    closePopup();
    if ('speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) { void e; } }
    updateHud();
    updateStationList();
    scrollListToActive();
    updateTrainChips();
    updateStationList();
    updateTrainChips();
    toast('当前控制：' + LINE_BY_KEY[ROUTES[state.routeKey].lineKey].short +
      '列车（' + M.byId[state.curId].zh + '站附近）');
  }

  /* ==================================================== 5. 运行状态机 */
  function routeIds(key) { return ROUTES[key].ids; }
  function idxOf(id) { return routeIds(state.routeKey).indexOf(id); }
  function terminusId() { return ROUTES[state.routeKey].terminus; }
  function lineOf(routeKey) { return LINE_BY_KEY[ROUTES[routeKey].lineKey]; }

  /* 切换交路（不重置列车位置：旧位置仍在新交路上就保位置，否则退到分叉站） */
  function switchService(key, quiet) {
    if (!ROUTES[key] || key === state.routeKey) return false;
    var r = ROUTES[key];
    var i = r.ids.indexOf(state.curId);
    var moved = false;
    state.routeKey = key;
    if (i < 0) {
      /* 当前站不在新交路上（如支线深段）：退到分叉站，而不是凭空移到起点站 */
      var jn = LINE_SWITCH[r.lineKey];
      if (jn && r.ids.indexOf(jn) >= 0) {
        i = r.ids.indexOf(jn);
        state.curId = jn;
      } else {
        i = 0;
        state.curId = r.ids[0];
      }
      state.posKm = r.kmAt[i];
      state.dir = 1;
      state.nextIdx = clamp(i + 1, 0, r.ids.length - 1);
      moved = true;
    } else {
      state.posKm = r.kmAt[i];
      state.nextIdx = clamp(i + state.dir, 0, r.ids.length - 1);
    }
    state.phase = 'dwell';
    state.phaseT = 0;
    state.door = 0;
    state.doorPhase = 'closed';
    state.v = 0;
    state.aOpened = true; state.aClosing = true; state.aDepart = true;   // 切交路不报站
    if (world) world.style.setProperty('--line', r.color);
    if (!quiet) {
      toast('交路切换为 ' + r.label + '（' + lineOf(key).short + '）' +
        (moved ? '，列车退至' + M.byId[state.curId].zh + '站' : ''));
    }
    recomputeEta();
    return true;
  }

  /* 找到跑某条线路的那列车（没有则返回 -1） */
  function trainIndexForLine(lineKey) {
    for (var i = 0; i < trains.length; i++) {
      if (ROUTES[trains[i].routeKey].lineKey === lineKey) return i;
    }
    return -1;
  }

  function resetState(keepTarget) {
    resetTrain(state, keepTarget);
    if (world) world.style.setProperty('--line', ROUTES[state.routeKey].color);
    recomputeEta();
  }

  function startReverse(st) {
    st.phase = 'reverse';
    st.phaseT = 0;
    st.v = 0;
    if (isActive(st)) toast('到达 ' + M.byId[st.curId].zh + '（终点站），折返换向中…');
  }

  function planNext(st) {
    var route = ROUTES[st.routeKey];
    var i = route.ids.indexOf(st.curId);

    /* 只停靠办理客运的站（在建/未开通站直接驶过） */
    function isStop(idx) {
      var s = M.byId[route.ids[idx]];
      return !(s && s.noStop);
    }
    function nextStop(idx, dir) {
      var j = idx + dir;
      while (j > 0 && j < route.ids.length - 1 && !isStop(j)) j += dir;
      return clamp(j, 0, route.ids.length - 1);
    }
    function terminusStop(dir) {
      var j = dir > 0 ? route.ids.length - 1 : 0;
      while (j > 0 && j < route.ids.length - 1 && !isStop(j)) j -= dir;
      return j;
    }
    var term = terminusStop(st.dir);

    function goRun(idx) {
      idx = clamp(idx, 0, route.ids.length - 1);
      st.nextIdx = idx;
      st.phase = 'run';
      st.v = 0;
    }

    /* 目标需要换交路：同线路在分叉站（四河）切换；跨线路不允许（派车前已切换） */
    if (st.target) {
      var want = serviceForStation(st.target, st.routeKey);
      if (want && want !== st.routeKey) {
        if (ROUTES[want].lineKey === route.lineKey) {
          var jn = LINE_SWITCH[route.lineKey];
          var j2 = jn ? route.ids.indexOf(jn) : -1;
          if (j2 >= 0 && i === j2) {
            st.routeKey = want;
            route = ROUTES[want];
            i = route.ids.indexOf(st.curId);
            st.posKm = route.kmAt[i];
            term = terminusStop(st.dir);
            if (world) world.style.setProperty('--line', route.color);
            if (isActive(st)) toast('在' + M.byId[jn].zh + '站切换交路 → ' + route.label);
          }
        } else {
          st.target = null;
          if (isActive(st)) toast('目标在另一条线路上，已取消；可在站点悬浮窗里“切换线路并派车”');
        }
      }
    }

    if (st.target) {
      var ti = route.ids.indexOf(st.target);
      if (ti >= 0) {
        var ahead = st.dir > 0 ? ti > i : ti < i;
        if (ahead) return goRun(nextStop(i, st.dir));
        if (i !== term) return goRun(nextStop(i, st.dir));     // 目标在身后：先到终点站
        return startReverse(st);
      }
      /* 目标在本线路另一条交路上（如支线站）：驶向分叉站换交路 */
      var jn3 = LINE_SWITCH[route.lineKey];
      var j3 = jn3 ? route.ids.indexOf(jn3) : -1;
      if (j3 >= 0) {
        var jAhead = st.dir > 0 ? j3 > i : j3 < i;
        if (jAhead || i !== term) return goRun(nextStop(i, st.dir));
        return startReverse(st);
      }
      st.target = null;
      return (i === term) ? startReverse(st) : goRun(nextStop(i, st.dir));
    }
    if (i === term) return startReverse(st);
    return goRun(nextStop(i, st.dir));
  }

  function arrive(st) {
    var route = ROUTES[st.routeKey];
    st.curId = route.ids[st.nextIdx];
    st.posKm = route.kmAt[st.nextIdx];
    st.v = 0;
    st.phase = 'dwell';
    st.phaseT = 0;
    st.doorPhase = 'opening';
    st.door = 0;
    st.aOpened = false; st.aClosing = false; st.aDepart = false;
    if (st.target && st.target === st.curId) {
      st.target = null;
      st.eta = null; st.etaStops = 0;
      if (isActive(st)) toast('已到达目标站：' + M.byId[st.curId].zh);
    }
  }

  function stepTrain(st, dt) {
    if (st.phase === 'dwell') {
      st.phaseT += dt;
      var t1 = CFG.openT, t2 = t1 + CFG.holdT, t3 = t2 + CFG.closeT, t4 = t3 + CFG.readyT;
      if (st.phaseT < t1) { st.doorPhase = 'opening'; st.door = st.phaseT / t1; }
      else if (st.phaseT < t2) { st.doorPhase = 'open'; st.door = 1; }
      else if (st.phaseT < t3) { st.doorPhase = 'closing'; st.door = 1 - (st.phaseT - t2) / CFG.closeT; }
      else { st.doorPhase = 'closed'; st.door = 0; }
      /* 报站时机：开门（到站）→ 关门警报 → 发车（下一站） */
      if (!st.aOpened) { st.aOpened = true; announce(st, 'arrive'); }
      if (st.phaseT >= t2 && !st.aClosing) { st.aClosing = true; announce(st, 'closing'); }
      if (st.phaseT >= t3 && !st.aDepart) { st.aDepart = true; announce(st, 'depart'); }
      if (st.phaseT >= t4) { st.door = 0; st.doorPhase = 'closed'; planNext(st); }
      return;
    }
    if (st.phase === 'reverse') {
      st.phaseT += dt;
      if (st.phaseT >= CFG.reverseT) { st.dir = -st.dir; planNext(st); }
      return;
    }
    /* run */
    var route = ROUTES[st.routeKey];
    var tKm = route.kmAt[st.nextIdx];
    var remain = Math.abs(tKm - st.posKm);
    var brakeKm = (st.v / 3.6) * (st.v / 3.6) / (2 * CFG.decel * 1000);
    if (remain <= brakeKm + 1e-9) {
      var vAllow = Math.sqrt(2 * CFG.decel * 1000 * remain) * 3.6;
      st.v = Math.min(st.v, vAllow);
      if (st.v < 4) st.v = Math.max(0, st.v - CFG.decel * 3.6 * dt);
      st.braking = true;
    } else {
      st.v = Math.min(CFG.vmax, st.v + CFG.accel * 3.6 * dt);
      st.braking = false;
    }
    var ds = st.dir * (st.v / 3600) * dt;
    st.posKm += ds;
    st.odometer += Math.abs(ds);
    var reached = (st.dir > 0 && st.posKm >= tKm - 0.0006) || (st.dir < 0 && st.posKm <= tKm + 0.0006);
    if (reached) arrive(st);
  }

  function cloneTrainState(tr) {
    var o = {};
    for (var k in tr) o[k] = tr[k];
    o.silent = true;
    return o;
  }
  function cloneState() { return cloneTrainState(state); }
  /* 只有当前控制的那列车才弹提示，背景列车静默运行 */
  function isActive(st) { return st === state; }

  /* 到任意站点的乘车时间预估：用同一套状态机预演一遍（不修改真实状态） */
  function etaFor(id) {
    if (!id || !M.byId[id]) return null;
    var st = M.byId[id];
    if (st.noStop) return { ok: false, reason: (st.status || '暂不办理客运') + '·列车不停靠', stops: 0 };
    if (!state.routeKey) return { ok: false, reason: '列车未上线', stops: 0 };
    var cur = ROUTES[state.routeKey];
    var want = serviceForStation(id, state.routeKey);
    if (!want) return { ok: false, reason: '该站不在任何交路上', stops: 0 };
    if (ROUTES[want].lineKey !== cur.lineKey) {
      return {
        ok: false, crossLine: true, wantKey: want, stops: 0,
        reason: '在' + LINE_BY_KEY[ROUTES[want].lineKey].short + '上，需先切换线路'
      };
    }
    if (state.curId === id && state.phase === 'dwell') {
      return { ok: true, seconds: 0, stops: 0, here: true };
    }
    var sim = cloneState();
    sim.target = id;
    var t = 0, steps = 0, stops = 0, prev = sim.curId, reversed = false, switched = false, dir0 = sim.dir;
    while (steps++ < 60000) {
      stepTrain(sim, 0.25);
      t += 0.25;
      if (sim.curId !== prev) { stops++; prev = sim.curId; }
      if (sim.dir !== dir0) reversed = true;
      if (sim.routeKey !== state.routeKey) switched = true;
      if (sim.curId === id && sim.phase === 'dwell') break;
    }
    if (steps >= 60000) return { ok: false, reason: '路线过长，无法预估', stops: 0 };
    return {
      ok: true, seconds: t, stops: stops, reversed: reversed, switched: switched,
      switchAt: switched ? LINE_SWITCH[cur.lineKey] : null
    };
  }

  function recomputeEta() {
    if (!state.target) { state.eta = null; state.etaStops = 0; return; }
    var e = etaFor(state.target);
    if (e && e.ok) { state.eta = e.seconds; state.etaStops = e.stops; }
    else { state.eta = null; state.etaStops = 0; }
  }

  function setTarget(id) {
    if (!id) { state.target = null; state.eta = null; state.etaStops = 0; refreshPopup(); return; }
    var st = M.byId[id];
    if (!st) return;
    if (st.noStop) {
      toast(st.zh + '（' + (st.status || '暂不办理客运') + '）不能作为目标站');
      return;
    }
    var want = serviceForStation(id, state.routeKey);
    if (!want) { toast('该站不在任何交路上'); return; }

    /* 跨线路：不把当前列车瞬移过去，而是把目标交给跑那条线的那列车 */
    if (ROUTES[want].lineKey !== ROUTES[state.routeKey].lineKey) {
      var ti = trainIndexForLine(ROUTES[want].lineKey);
      if (ti < 0) { toast('没有跑 ' + LINE_BY_KEY[ROUTES[want].lineKey].short + ' 的列车'); return; }
      if (ti !== activeIdx) {
        setActive(ti);
        activateSideEffects();
      }
      /* 同线路内换交路（主线↔支线）：只换交路，不动位置 */
      if (ROUTES[state.routeKey].ids.indexOf(id) < 0) switchService(want, true);
    }
    /* 同线路的目标不调 switchService：交给 planNext 在分叉站自然切换交路（位置不变） */
    state.target = id;
    selected = id;
    recomputeEta();
    var msg;
    if (state.curId === id) msg = '列车已在 ' + st.zh + ' 站';
    else {
      var e = etaFor(id);
      var behind = !!(e && (e.reversed || e.switched));
      msg = LINE_BY_KEY[ROUTES[state.routeKey].lineKey].short + '列车 → ' + st.zh + ' 站' +
        (behind ? '（需先折返/换交路）' : '') + '，预计 ' + (e && e.ok ? fmtDur(e.seconds) : '较长');
    }
    toast(msg);
    refreshPopup();
    updateStationList();
    scrollListToActive();
  }

  /* ==================================================== 6. 视图（Pointer Events） */
  var pointers = new Map(), gesture = null, lastTap = { t: 0, x: 0, y: 0 };
  var popupId = null, popupEta = null, popupEtaAt = 0, lastTapHandled = 0, lastGestureEnd = 0;

  function applyView() {
    $('viewport').setAttribute('transform',
      'translate(' + f2(view.tx) + ',' + f2(view.ty) + ') scale(' + view.k.toFixed(4) + ')');
  }

  function contentBox() {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    M.stations.forEach(function (s) {
      x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x);
      y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y);
    });
    /* 左上留宽一点：给 HUD / 面板按钮腾位置，避免遮住端点站（如犀浦） */
    return {
      x0: x0 - VIEW_MARGIN.x - 90, y0: y0 - VIEW_MARGIN.y - 80,
      x1: x1 + VIEW_MARGIN.x - 40, y1: y1 + VIEW_MARGIN.y - 30
    };
  }

  function fitView() {
    var c = contentBox();
    var k = Math.min(stage.w / (c.x1 - c.x0), stage.h / (c.y1 - c.y0));
    view.k = clamp(k, 0.12, 20);
    view.tx = stage.w / 2 - (c.x0 + c.x1) / 2 * view.k;
    view.ty = stage.h / 2 - (c.y0 + c.y1) / 2 * view.k;
    view.fitted = true;
    clampView();
    applyView();
    updateLabelScale();
    updateScaleBar();
  }

  function minZoom() {
    var c = contentBox();
    return Math.min(stage.w / (c.x1 - c.x0), stage.h / (c.y1 - c.y0)) * 0.82;
  }

  function clampView() {
    view.k = clamp(view.k, minZoom(), 16);
    var c = panBox();
    var x0 = c.x0, x1 = c.x1, y0 = c.y0, y1 = c.y1;
    var k = view.k;
    if (x1 * k - x0 * k <= stage.w) view.tx = stage.w / 2 - (x0 + x1) / 2 * k;
    else {
      if (x0 * k + view.tx > 0) view.tx = -x0 * k;
      if (x1 * k + view.tx < stage.w) view.tx = stage.w - x1 * k;
    }
    if (y1 * k - y0 * k <= stage.h) view.ty = stage.h / 2 - (y0 + y1) / 2 * k;
    else {
      if (y0 * k + view.ty > 0) view.ty = -y0 * k;
      if (y1 * k + view.ty < stage.h) view.ty = stage.h - y1 * k;
    }
  }

  /* 可平移范围：线路范围再放宽 6%，防止把线路拖出屏幕外 */
  function panBox() {
    var c = contentBox(), w = c.x1 - c.x0, h = c.y1 - c.y0;
    return { x0: c.x0 - w * 0.06, y0: c.y0 - h * 0.06, x1: c.x1 + w * 0.06, y1: c.y1 + h * 0.06 };
  }

  function zoomAt(px, py, factor) {
    var k0 = view.k;
    var k1 = clamp(k0 * factor, minZoom(), 16);
    if (k1 === k0) return;
    view.tx = px - (px - view.tx) / k0 * k1;
    view.ty = py - (py - view.ty) / k0 * k1;
    view.k = k1;
    clampView(); applyView(); updateLabelScale(); updateScaleBar(); view.fitted = false;
  }

  /* 把 client 坐标换算到 SVG 用户坐标（viewBox 单位）。
     正常情况下 1 用户单位 == 1 CSS px；preserveAspectRatio=none + 比例换算保证
     即使元素尺寸瞬时与 viewBox 不一致（iOS 工具栏/面板变化），点站依然准确。 */
  function localPos(e) {
    var r = $('map').getBoundingClientRect();
    var sx = r.width > 0 ? stage.w / r.width : 1;
    var sy = r.height > 0 ? stage.h / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  function onPointerDown(e) {
    var p = localPos(e);
    try { $('map').setPointerCapture(e.pointerId); } catch (err) { /* 合成事件/旧浏览器无关紧要 */ }
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      gesture = { mode: 'tap', startX: p.x, startY: p.y, startT: performance.now(), moved: 0 };
    } else if (pointers.size === 2) {
      var arr = Array.from(pointers.values());
      gesture = {
        mode: 'pinch',
        d0: Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) || 1,
        m0: { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 },
        k0: view.k, tx0: view.tx, ty0: view.ty
      };
      lastGestureEnd = performance.now();
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    var p = localPos(e);
    pointers.set(e.pointerId, p);
    if (!gesture) return;
    if (gesture.mode === 'pinch' && pointers.size >= 2) {
      var arr = Array.from(pointers.values());
      var d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) || 1;
      var m = { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
      var k = clamp(gesture.k0 * d / gesture.d0, minZoom(), 16);
      var mapX = (gesture.m0.x - gesture.tx0) / gesture.k0, mapY = (gesture.m0.y - gesture.ty0) / gesture.k0;
      view.k = k;
      view.tx = m.x - mapX * k;
      view.ty = m.y - mapY * k;
      view.fitted = false;
      setFollow(false);
      clampView(); applyView(); updateScaleBar();
      return;
    }
    if (gesture.mode === 'tap') {
      var dx = p.x - gesture.startX, dy = p.y - gesture.startY;
      var dist = Math.hypot(dx, dy);
      gesture.moved = Math.max(gesture.moved, dist);
      if (dist > CFG.tapMove) {
        gesture.mode = 'pan';
        gesture.k0 = view.k; gesture.tx0 = view.tx; gesture.ty0 = view.ty;
        lastGestureEnd = performance.now();
        $('map').classList.add('dragging');
        setFollow(false);
      }
    }
    if (gesture.mode === 'pan') {
      view.tx = gesture.tx0 + (p.x - gesture.startX);
      view.ty = gesture.ty0 + (p.y - gesture.startY);
      view.fitted = false;
      clampView(); applyView();
    }
  }

  function onPointerUp(e) {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    $('map').classList.remove('dragging');
    var still = gesture && gesture.mode === 'tap' && gesture.moved <= CFG.tapMove;
    var wasPinch = gesture && gesture.mode === 'pinch';
    var pos = localPos(e);
    if (wasPinch) { updateLabelScale(); lastGestureEnd = performance.now(); }
    gesture = pointers.size ? null : gesture;
    if (!still) { gesture = null; return; }
    gesture = null;
    var now = performance.now();
    var isDouble = (now - lastTap.t) < CFG.dblMs && Math.hypot(pos.x - lastTap.x, pos.y - lastTap.y) < 36;
    lastTap = { t: isDouble ? 0 : now, x: pos.x, y: pos.y };
    if (isDouble) { zoomAt(pos.x, pos.y, 1.9); return; }
    handleTap(pos);
  }

  /* 轻点：先判列车 → 再判站点 → 都没命中则收起气泡/关闭悬浮窗 */
  function handleTap(pos) {
    lastTapHandled = performance.now();
    var ti = hitTrain(pos);
    if (ti >= 0) {
      if (ti !== activeIdx) { setActive(ti); activateSideEffects(); }
      else { toast('当前已是这列车：' + LINE_BY_KEY[ROUTES[state.routeKey].lineKey].short); }
      return;
    }
    var hit = hitStation(pos);
    if (hit) { openPopup(hit, pos); return; }
    collapseBubbles();
    closePopup();
  }

  function hitStation(p) {
    var best = null, bestD = CFG.tapRadius;
    M.stations.forEach(function (st) {
      var sx = st.x * view.k + view.tx, sy = st.y * view.k + view.ty;
      var d = Math.hypot(sx - p.x, sy - p.y);
      if (d < bestD) { bestD = d; best = st.id; }
    });
    return best;
  }

  function onWheel(e) {
    e.preventDefault();
    var p = localPos(e);
    zoomAt(p.x, p.y, Math.pow(0.9993, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
  }

  function setFollow(on) {
    if (ui.follow === on) { $('chkFollow').checked = on; return; }
    ui.follow = on;
    $('chkFollow').checked = on;
    if (on) {
      var k = clamp(Math.max(view.k, 3.0), minZoom(), 16);
      zoomAt(stage.w / 2, stage.h / 2, k / view.k);
      followStep(0, true);          // 立即对中到列车，避免开启动画期间看不到车
    }
  }

  function followStep(dt, snap) {
    if (!ui.follow) return;
    var route = ROUTES[state.routeKey];
    var p = pointAt(route, kmToMap(route, state.posKm));
    var wantX = stage.w / 2 - p.x * view.k;
    var wantY = stage.h * 0.55 - p.y * view.k;
    var a = snap ? 1 : (1 - Math.exp(-7 * dt));
    view.tx += (wantX - view.tx) * a;
    view.ty += (wantY - view.ty) * a;
    clampView();
    applyView();
  }

  /* ==================================================== 面板 / HUD 更新 */
  var hudCache = {};
  function setText(id, txt) {
    if (hudCache[id] === txt) return;
    hudCache[id] = txt;
    var el = $(id);
    if (el) el.textContent = txt;
  }

  function phaseLabel() {
    if (ui.paused) return '已暂停';
    if (state.phase === 'reverse') return '折返中';
    if (state.phase === 'dwell') {
      if (state.doorPhase === 'opening') return '停站 · 开门中';
      if (state.doorPhase === 'open') return '停站 · 开门';
      if (state.doorPhase === 'closing') return '停站 · 关门中';
      return '停站 · 待发车';
    }
    if (state.v <= 0.3) return '启动中';
    if (state.braking) return '制动进站';
    return state.v >= CFG.vmax - 0.4 ? '巡航' : '加速中';
  }

  function updateHud() {
    var route = ROUTES[state.routeKey];
    setText('hudDir', '往' + M.byId[terminusId()].zh + ' · ' + (state.dir > 0 ? '下行' : '上行') + ' · ' + lineOf(state.routeKey).short);
    var doorEl = $('hudDoor');
    var doorTxt, doorCls;
    if (state.phase === 'dwell' && state.doorPhase === 'opening') { doorTxt = '开门中'; doorCls = 'opening'; }
    else if (state.phase === 'dwell' && state.doorPhase === 'open') { doorTxt = '车门开启'; doorCls = 'open'; }
    else if (state.phase === 'dwell' && state.doorPhase === 'closing') { doorTxt = '关门中'; doorCls = 'closing'; }
    else { doorTxt = '车门关闭'; doorCls = ''; }
    if (hudCache.__door !== doorTxt) {
      hudCache.__door = doorTxt;
      doorEl.textContent = doorTxt;
      doorEl.className = 'chip chip-door ' + doorCls;
    }
    setText('hudPhase', phaseLabel());
    setText('hudCur', (state.curId ? M.byId[state.curId].zh : '—') + ' 站');
    var nx = route.ids[state.nextIdx];
    setText('hudNext', state.phase === 'reverse' ? '折返换向' : (nx ? M.byId[nx].zh + ' 站' : '—'));
    setText('hudTarget', state.target ? M.byId[state.target].zh + ' 站' : '—');
    setText('hudOdo', state.odometer.toFixed(2) + ' km');
    setText('hudSpeed', state.v.toFixed(0) + ' km/h');
    setText('hudEta', state.eta != null ? fmtDur(state.eta) : '—');
    setText('tgName', state.target ? M.byId[state.target].zh + ' 站' : '未设置');
    setText('tgEta', state.eta != null ? fmtDur(state.eta) + '（实时 ' + fmtDur(state.eta / ui.mult) + '）' : '—');
    setText('tgStops', state.etaStops ? state.etaStops + ' 站' : '—');
  }

  var toastT = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* 站点列表 */
  function buildStationList() {
    var box = $('stlist');
    box.innerHTML = '';
    (M.lines || []).forEach(function (line) {
      line.services.forEach(function (svc, si) {
        var r = ROUTES[svc.key];
        var ids = r.ids;
        /* 支线不重复列出与前一条交路共用的区段（从分叉站开始列） */
        var from = 0;
        if (si > 0 && line.services.length > 1) {
          var a = ROUTES[line.services[0].key].ids, n = 0;
          while (n < a.length && n < ids.length && a[n] === ids[n]) n++;
          from = Math.max(0, n - 1);
        }
        var h = document.createElement('div');
        h.className = 'grp';
        h.textContent = line.short + ' · ' + svc.label;
        box.appendChild(h);
        ids.slice(from).forEach(function (id, k) {
          var st = M.byId[id];
          var seq = from + k;
          var b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('data-st', id);
          var no = document.createElement('span');
          no.className = 'no';
          no.textContent = (si > 0 && line.services.length > 1)
            ? ('0' + line.key + '|Y' + (seq - from + 1))
            : ('0' + line.key + '|' + String(seq + 1).padStart(2, '0'));
          var nm = document.createElement('span');
          nm.className = 'nm';
          nm.textContent = st.zh;
          b.appendChild(no);
          b.appendChild(nm);
          if (st.lines && st.lines.length > 1) {
            var t0 = document.createElement('span'); t0.className = 'tag tr';
            t0.textContent = '换乘'; b.appendChild(t0);
          } else if (st.tr && st.tr.length) {
            var t = document.createElement('span'); t.className = 'tag tr';
            t.textContent = st.tr.join('/'); b.appendChild(t);
          }
          if (st.term) { var t2 = document.createElement('span'); t2.className = 'tag'; t2.textContent = '端点'; b.appendChild(t2); }
          if (st.status) { var t3 = document.createElement('span'); t3.className = 'tag'; t3.textContent = st.status; b.appendChild(t3); }
          b.addEventListener('click', function () { setTarget(id); updateStationList(); });
          box.appendChild(b);
        });
      });
    });
    $('stCount').textContent = '共 ' + M.stations.length + ' 站 · ' + (M.lines || []).length + ' 条线路';
    updateStationList();
  }

  /* 线路 / 交路选择器（按线路分组） */
  function buildLineSelector() {
    var sel = $('selRoute');
    sel.innerHTML = '';
    (M.lines || []).forEach(function (line) {
      var og = document.createElement('optgroup');
      og.label = line.short + ' · ' + line.name;
      line.services.forEach(function (s) {
        var op = document.createElement('option');
        op.value = s.key;
        op.textContent = s.label;
        og.appendChild(op);
      });
      sel.appendChild(og);
    });
    sel.value = state.routeKey;
  }

  function updateStationList() {
    var btns = $('stlist').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var id = btns[i].getAttribute('data-st');
      btns[i].classList.toggle('here', id === state.curId);
      btns[i].classList.toggle('target', id === state.target);
    }
  }

  /* 站点列表跟随当前列车：把当前站滚进可视区 */
  var lastScrolledKey = null;
  function scrollListToActive() {
    var box = $('stlist');
    if (!box) return;
    var key = activeIdx + '|' + state.curId;
    if (key === lastScrolledKey) return;
    lastScrolledKey = key;
    var b = box.querySelector('[data-st="' + state.curId + '"]');
    if (!b || !b.scrollIntoView) return;
    try { b.scrollIntoView({ block: 'nearest' }); }
    catch (e) { try { b.scrollIntoView(false); } catch (e2) { void e2; } }
  }

  /* ============================================ 版本戳与「检查更新 / 刷新」
     背景：iPad「添加到主屏」后在 standalone 模式下没有地址栏、没有刷新按钮，
     而且 GitHub Pages 的 HTML/JS 带 cache-control: max-age=600，关掉重开也可能还是旧版。
     因此提供：① 页面内可见版本戳（读 version.json，cache:'no-store'）
             ② 「⟳ 检查更新」按钮：拉一次服务器版本比对，不同→带 _v= 新版号 location.replace 强刷；
                相同→提示已是最新，4 秒内再点一下则强制 cache-busting 重载。
     version.json 由 tools/bump-version.sh 生成（发版流程见 README）。 */
  var BUILD_VERSION = null;      // 页面“加载时”的版本（一旦确定不再被后续检查覆盖）
  var REMOTE_VERSION = null;     // 最近一次从服务器拉到的版本（用于比对）
  var forceNextRefresh = false;  // 已是最新后再点一下 = 强制刷新
  var refreshBusy = false;

  function refreshUrlFor(href, stamp) {
    var u = new URL(href, location.href);
    u.searchParams.set('_v', stamp == null ? String(Date.now()) : String(stamp));
    return u.pathname + u.search + u.hash;      // 保留原查询参数（如 selftest=1）与 hash，仅覆盖 _v
  }

  function setVerText(main, extra, cls) {
    var t = $('verText'), b = $('verBadge');
    if (t) t.innerHTML = main + (extra ? ' · ' + extra : '');
    if (b) {
      b.textContent = main.replace(/<[^>]*>/g, '');
      b.className = 'ver-badge' + (cls ? ' ' + cls : '');
    }
  }

  function renderVersion(v) {
    if (v && v.version) {
      BUILD_VERSION = v;
      var short = v.commit && v.commit !== 'unknown' ? v.commit : '';
      setVerText('v' + v.version, short ? '<b>' + short + '</b>' : '', 'fresh');
    } else {
      setVerText('v未知', '无法读取 version.json', '');
    }
  }

  function fetchVersion(bust, asLoaded) {
    var url = 'version.json' + (bust ? '?_v=' + Date.now() : '');
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.version) {
          REMOTE_VERSION = j;
          if (asLoaded || !BUILD_VERSION) {        // 首次：这就是“加载时的版本”
            BUILD_VERSION = j;
            renderVersion(j);
          }
        } else if (asLoaded || !BUILD_VERSION) {
          renderVersion(null);
        }
        return j;
      })
      .catch(function () {
        if (asLoaded || !BUILD_VERSION) renderVersion(null);
        return null;
      });
  }

  /* 真正跳转只在这里发生（单独抽出来，便于自检用桩验证） */
  var navigateTo = function (url) { location.replace(url); };
  var lastReloadUrl = null;      // 最近一次准备重载的地址（自检断言用）

  /* 防跑飞：60 秒内自动重载超过 3 次就不再自动跳（避免某些异常变成无限刷新把 standalone 应用卡死） */
  function reloadBudgetLeft() {
    try {
      var now = Date.now();
      var arr = JSON.parse(sessionStorage.getItem('metro_reloads') || '[]');
      arr = arr.filter(function (t) { return now - t < 60000; });
      if (arr.length >= 3) return false;
      arr.push(now);
      sessionStorage.setItem('metro_reloads', JSON.stringify(arr));
    } catch (e) { void e; }
    return true;
  }

  function reloadFresh(label, nav) {
    setVerText(label || '正在更新…', '', 'busy');
    var url = refreshUrlFor(location.href);
    lastReloadUrl = url;
    if (!reloadBudgetLeft()) {
      setVerText('刷新过于频繁', '已暂停自动刷新，请稍后手动点「⟳ 刷新」', '');
      return;
    }
    setTimeout(function () { (nav || navigateTo)(url); }, 250);
  }

  /* 自检用：重置“防跑飞”计数 */
  function resetReloadBudget() {
    try { sessionStorage.removeItem('metro_reloads'); } catch (e) { void e; }
  }

  function checkUpdate(force) {
    if (refreshBusy) return;
    refreshBusy = true;
    if (force) { refreshBusy = false; reloadFresh('正在强制重新加载…'); return; }
    setVerText('正在检查…', '', 'busy');
    fetchVersion(true).then(function (remote) {
      refreshBusy = false;
      var loaded = BUILD_VERSION && BUILD_VERSION.version;
      var remoteV = (REMOTE_VERSION && REMOTE_VERSION.version) || (remote && remote.version) || null;
      /* 拉不到版本（离线 / file:// / 网络失败）不能直接重载，否则会无限刷新；
         此时只提示失败，并在 4 秒内允许再点一下强制刷新。 */
      if (!remoteV) {
        setVerText('v未知', '检查失败（再点一下强制刷新）', '');
        forceNextRefresh = true;
        setTimeout(function () {
          if (!forceNextRefresh) return;
          forceNextRefresh = false;
          renderVersion(BUILD_VERSION);
        }, 4000);
        return;
      }
      if (!loaded || remoteV !== loaded) {
        reloadFresh('发现新版本 ' + remoteV + '，正在更新…');
        return;
      }
      setVerText('v' + loaded, '已是最新（再点一下强制刷新）', 'fresh');
      forceNextRefresh = true;
      setTimeout(function () {
        if (!forceNextRefresh) return;
        forceNextRefresh = false;
        renderVersion(BUILD_VERSION);
      }, 4000);
    });
  }

  /* 强制刷新：不看版本、直接用 cache-busting 地址整页重拉（资源还会按版本号换 URL）
     nav 参数只为自检打桩预留（传入则用它代替 location.replace，不会真的跳转）。 */
  function hardReload(nav) {
    var b = $('btnHardRefresh');
    if (b) { b.textContent = '⟳ 刷新中…'; b.classList.add('busy'); }
    if ('speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) { void e; } }
    reloadFresh('正在强制刷新…', nav);
  }

  function bindVersionUI() {
    var btn = $('btnRefresh'), badge = $('verBadge'), hard = $('btnHardRefresh');
    function onTap(e) {
      e.preventDefault();
      e.stopPropagation();
      if (forceNextRefresh) { forceNextRefresh = false; checkUpdate(true); return; }
      checkUpdate(false);
    }
    if (btn) btn.addEventListener('click', onTap);
    if (badge) badge.addEventListener('click', onTap);
    if (hard) hard.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hardReload(); });
    fetchVersion(false, true);      // 首次拉取：决定“加载时的版本”
  }

  /* ==================================================== 面板：列车选择 */
  function buildTrainChips() {
    var box = $('trainChips');
    if (!box) return;
    box.innerHTML = '';
    trains.forEach(function (tr, ti) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tchip';
      b.setAttribute('data-train', ti);
      b.addEventListener('click', function () {
        if (ti !== activeIdx) { setActive(ti); activateSideEffects(); }
      });
      box.appendChild(b);
    });
    updateTrainChips();
  }

  function updateTrainChips() {
    var box = $('trainChips');
    if (!box) return;
    trains.forEach(function (tr, ti) {
      var b = box.querySelector('[data-train="' + ti + '"]');
      if (!b) return;
      var line = LINE_BY_KEY[ROUTES[tr.routeKey].lineKey];
      var nx = ROUTES[tr.routeKey].ids[tr.nextIdx];
      var st = tr.phase === 'reverse' ? '折返中' : (tr.phase === 'dwell' ? (tr.doorPhase === 'open' ? '开门中' : '停站') : tr.v.toFixed(0) + ' km/h');
      var sig = line.short + '|' + M.byId[tr.curId].zh + '|' + (nx ? M.byId[nx].zh : '—') + '|' + st + '|' + (ti === activeIdx);
      if (b.__sig === sig) return;
      b.__sig = sig;
      b.className = 'tchip' + (ti === activeIdx ? ' on' : '');
      b.innerHTML = '<span class="tchip-dot" style="background:' + line.color + '"></span>' +
        '<span class="tchip-line">' + line.short + '</span>' +
        '<span class="tchip-pos">' + M.byId[tr.curId].zh + ' → ' + (nx ? M.byId[nx].zh : '—') + '</span>' +
        '<span class="tchip-st">' + st + '</span>';
    });
  }

  /* ==================================================== 声音：BGM / 音效 / 语音播报
     设计取舍（重要）：
     * BGM 默认用 **Web Audio 实时合成**的“地铁运行”环境声（绍噪声 + 低频轰鸣，4s 无缝循环）；
       如果仓库里放了 audio/bgm.mp3（或用户自备）则优先用这个文件。
       为什么没有直接下一个音频文件：Wikimedia Commons 上唯一的 CC 许可地铁环境声都是 .ogg/.flac，
       而 iOS Safari 对 Ogg Vorbis 支持不可靠，本机又没有 ffmpeg/编码器可以转成 mp3/m4a（详见 README）。
     * 开门/关门提示音：Web Audio 合成的双音铃声。
     * 报站：用浏览器自带的 speechSynthesis（zh-CN）朗读，不依赖任何外部资源。
     * iOS/Safari 要求音频必须由用户手势开启：先默认为静音，用户点「声音」按钮后才启动。 */
  var audio = {
    ctx: null, master: null, bgmGain: null, synth: null, fileEl: null, useFile: false,
    on: false, vol: 0.6, announcements: 0
  };

  /* 想用真实录音当 BGM：把文件放进仓库（如 audio/bgm.mp3）并把下面这行改成 'audio/bgm.mp3'。
     留空（默认）则只用下面实时合成的环境声，也不会发出任何多余请求。 */
  var BGM_FILE = '';

  function bgmEnabled(flag) {
    if (audio.bgmGain) audio.bgmGain.gain.value = flag ? 0.16 * audio.vol : 0;
    if (audio.fileEl) audio.fileEl.volume = flag && audio.useFile ? 0.35 * audio.vol : 0;
    if (audio.fileEl) {
      if (flag && audio.useFile) { var p = audio.fileEl.play(); if (p && p.catch) p.catch(function () {}); }
      else audio.fileEl.pause();
    }
  }

  function initAudio() {
    if (audio.ctx) return audio.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    var ctx = new AC();
    var master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    audio.ctx = ctx;
    audio.master = master;

    /* —— 合成的地铁环境声（4s 无缝循环）—— */
    var g = ctx.createGain();
    g.gain.value = 0;
    g.connect(master);
    audio.bgmGain = g;
    var sr = ctx.sampleRate, len = 4, buf = ctx.createBuffer(1, sr * len, sr), d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < d.length; i++) {
      var white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;                 // 绍噪声
      var t = i / sr;
      var rumble = Math.sin(2 * Math.PI * 46 * t) * 0.05 + Math.sin(2 * Math.PI * 71 * t) * 0.028;
      d[i] = (last * 3.1 + rumble) * 0.35;
    }
    var fade = Math.floor(sr * 0.4);                        // 循环首尾交叉淡化，避免接头“咔”声
    for (var k = 0; k < fade; k++) {
      var w = k / fade;
      d[k] = d[k] * w + d[d.length - fade + k] * (1 - w);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 430;
    lp.Q.value = 0.6;
    src.connect(lp);
    lp.connect(g);
    try { src.start(); } catch (e) { void e; }
    audio.synth = src;

    /* —— 可选：BGM_FILE（自备录音）优先 —— */
    if (BGM_FILE) {
      try {
        var el = document.createElement('audio');
        el.loop = true;
        el.preload = 'auto';
        el.src = BGM_FILE;
        el.volume = 0;
        el.addEventListener('canplaythrough', function () { audio.useFile = true; bgmEnabled(audio.on); });
        el.addEventListener('error', function () { audio.useFile = false; });
        document.body.appendChild(el);
        audio.fileEl = el;
      } catch (e) { void e; }
    }
    return ctx;
  }

  /* 双音提示音：'open' 上行、'close' 下行、'warn' 两声短促 */
  function chime(kind) {
    if (!audio.on) return;
    var ctx = initAudio();
    if (!ctx) return;
    var now = ctx.currentTime + 0.02;
    var seq = kind === 'open' ? [[784, 0], [1046.5, 0.18]]
      : kind === 'close' ? [[1046.5, 0], [784, 0.18]]
        : [[988, 0], [988, 0.24]];
    seq.forEach(function (s) {
      var o = ctx.createOscillator(), gg = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = s[0];
      gg.gain.setValueAtTime(0.0001, now + s[1]);
      gg.gain.linearRampToValueAtTime(kind === 'warn' ? 0.16 : 0.2 * audio.vol, now + s[1] + 0.02);
      gg.gain.exponentialRampToValueAtTime(0.0001, now + s[1] + 0.45);
      o.connect(gg);
      gg.connect(audio.master);
      o.start(now + s[1]);
      o.stop(now + s[1] + 0.5);
    });
  }

  function zhVoice() {
    if (!('speechSynthesis' in window)) return null;
    var vs = window.speechSynthesis.getVoices() || [];
    for (var i = 0; i < vs.length; i++) if (/^zh/i.test(vs[i].lang)) return vs[i];
    return null;
  }

  function speak(text, cancelPrev) {
    if (!audio.on || !text || !('speechSynthesis' in window)) return;
    try {
      var ss = window.speechSynthesis;
      if (cancelPrev) ss.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.0;
      u.pitch = 1.0;
      var v = zhVoice();
      if (v) u.voice = v;
      ss.speak(u);
      audio.announcements++;
    } catch (e) { void e; }
  }

  /* 报站文案（纯函数，便于自检） */
  function announceText(kind, ctxObj) {
    if (kind === 'arrive') return ctxObj.zh + '站到了，请下车，注意列车与站台之间的空隙';
    if (kind === 'closing') return '车门即将关闭，请勿靠近车门';
    if (kind === 'depart') return '欢迎乘坐成都地铁' + ctxObj.line + '，下一站 ' + ctxObj.next;
    return '';
  }

  /* 发车报站用的“下一站”（停站中 nextIdx 还指向本车所在的站） */
  function nextStopAfter(tr) {
    var r = ROUTES[tr.routeKey];
    var i = r.ids.indexOf(tr.curId);
    var j = i + tr.dir;
    if (i < 0) return null;
    if (j < 0 || j >= r.ids.length) return null;      // 已在端点，即将折返
    return r.ids[j];
  }

  function announce(st, kind) {
    if (!isActive(st) || st.silent) return;
    var r = ROUTES[st.routeKey];
    var after = nextStopAfter(st);
    var ctxObj = {
      zh: M.byId[st.curId] ? M.byId[st.curId].zh : '',
      next: after && M.byId[after] ? M.byId[after].zh : '',
      line: LINE_BY_KEY[r.lineKey].key
    };
    var text = kind === 'arrive' ? announceText('arrive', ctxObj)
      : kind === 'closing' ? announceText('closing', ctxObj)
        : (after ? announceText('depart', ctxObj) : '欢迎乘坐成都地铁' + ctxObj.line + '，本次列车已到达终点站');
    /* 字幕：不管能不能出声都显示报站内容（iOS 主屏 standalone 对 TTS 有限制时也有反馈） */
    showAnnounce(text);
    if (!audio.on) return;
    if (kind === 'arrive') { chime('open'); speak(ui.mult >= 2 ? ctxObj.zh + '站' : text, true); }
    else if (kind === 'closing') { chime('warn'); speak(text, false); }
    else { chime('close'); speak(text, false); }
  }

  /* 报站字幕条（舞台下方居中；TTS 被限制时也能“看”到报站） */
  var aBox = null, aTimer = null;
  function showAnnounce(text) {
    if (!text) return;
    if (!aBox) {
      aBox = document.createElement('div');
      aBox.id = 'announce';
      aBox.className = 'announce';
      $('stage').appendChild(aBox);
    }
    aBox.textContent = text;
    aBox.classList.add('show');
    if (aTimer) clearTimeout(aTimer);
    aTimer = setTimeout(function () { aBox.classList.remove('show'); }, 6000);
  }

  function setSound(on) {
    audio.on = !!on;
    var b = $('btnSound');
    if (b) {
      b.textContent = audio.on ? '🔊 声音开启' : '🔇 声音关闭';
      b.setAttribute('aria-pressed', audio.on ? 'true' : 'false');
      b.classList.toggle('btn-on', audio.on);
    }
    if (audio.on) {
      var ctx = initAudio();
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
      bgmEnabled(true);
      speak('声音已开启，欢迎乘坐豆豆国的地铁', true);
    } else {
      bgmEnabled(false);
      if ('speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) { void e; } }
    }
  }

  /* ==================================================== 站点悬浮窗（iPad 主要交互） */
  function setChipLine(el, key) {
    var c = LINE_COLORS[key] || LINE_COLORS['1'] || M.lineColor;
    el.style.background = c;
  }

  function openPopup(id, at) {
    var st = M.byId[id];
    if (!st) return;
    popupId = id;
    selected = id;
    var key = (st.lines && st.lines[0]) || '1';
    setChipLine($('spLine'), key);
    $('spLine').textContent = (st.lines && st.lines.length ? st.lines.join('·') : '1') + '号线';
    $('spZh').textContent = st.zh;
    $('spEn').textContent = st.en || '';
    var tr = (st.lines && st.lines.length > 1)
      ? (st.lines.join('/') + ' 号线换乘')
      : ((st.tr && st.tr.length) ? (st.tr.join('、') + ' 号线') : '无');
    if (st.planned && st.planned.length) tr += '（在建：' + st.planned.join('、') + '）';
    $('spTr').textContent = tr;
    $('spKm').textContent = stationKm(id).toFixed(2) + ' km' + (st.status && st.status !== '运营中' ? ' · ' + st.status : '');
    $('stpop').hidden = false;
    popupEtaAt = 0;
    refreshPopup(true);
    positionPopup(at);
    labelEls.forEach(function (L) { L.g.classList.toggle('hot', L.st.id === id); });
  }

  function closePopup() {
    if (!popupId) return;
    popupId = null;
    popupEta = null;
    $('stpop').hidden = true;
    labelEls.forEach(function (L) { L.g.classList.remove('hot'); });
  }

  /* 悬浮窗始终完整地留在舞台内 */
  function positionPopup(at) {
    var box = $('stpop');
    if (box.hidden) return;
    var w = box.offsetWidth || 268, h = box.offsetHeight || 300;
    var x, y;
    if (at) { x = at.x + 16; y = at.y - h * 0.34; }
    else if (popupId) {
      var st = M.byId[popupId];
      x = st.x * view.k + view.tx + 16;
      y = st.y * view.k + view.ty - h * 0.34;
    } else return;
    var m = 8;
    x = clamp(x, m, Math.max(m, stage.w - w - m));
    y = clamp(y, m, Math.max(m, stage.h - h - m));
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
  }

  function refreshPopup(force) {
    if (!popupId) return;
    var st = M.byId[popupId];
    var now = performance.now();
    if (force || !popupEta || now - popupEtaAt > 600) {
      popupEta = etaFor(popupId);
      popupEtaAt = now;
    }
    var e = popupEta;
    if (e && e.ok) {
      if (e.here) {
        $('spEta').textContent = '已在该站';
        $('spEtaLbl').textContent = '列车正停靠本站';
      } else {
        $('spEta').textContent = fmtDur(e.seconds);
        $('spEtaLbl').textContent = '列车到达该站' + (ui.mult !== 1 ? '（实时 ' + fmtDur(e.seconds / ui.mult) + '）' : '');
      }
      $('spStops').textContent = e.stops ? e.stops + ' 站' : '—';
      var plan = e.reversed && e.switched ? '需先驶向终点折返，再在四河站换交路后到达'
        : e.reversed ? '目标在当前方向后方：先到终点折返换向'
        : e.switched ? '需在四河站切换交路后到达'
        : '当前方向沿线直达';
      $('spPlan').textContent = plan;
    } else {
      $('spEta').textContent = '—';
      $('spEtaLbl').textContent = (e && e.reason) || '无法预估';
      $('spStops').textContent = '—';
      $('spPlan').textContent = (e && e.reason) || '该站当前不可到达';
    }
    var doorTxt = state.phase === 'dwell'
      ? (state.doorPhase === 'opening' ? '开门中' : state.doorPhase === 'open' ? '车门开启' : state.doorPhase === 'closing' ? '关门中' : '待发车')
      : '车门关闭';
    var stTxt = ui.paused ? '已暂停'
      : state.phase === 'dwell' ? doorTxt
      : state.phase === 'reverse' ? '折返换向中'
      : phaseLabel();
    $('spState').textContent = stTxt + ' · ' + state.v.toFixed(0) + ' km/h';
    var route = ROUTES[state.routeKey];
    var nx = route.ids[state.nextIdx];
    $('spNow').textContent = (state.curId ? M.byId[state.curId].zh : '—') + '站 → ' +
      (state.phase === 'reverse' ? '折返换向' : (nx ? M.byId[nx].zh + '站' : '—'));
    var go = $('spGo');
    var reachable = e && e.ok;
    if (state.target === popupId) {
      go.textContent = '已定为目标站（点击取消）';
      go.disabled = false;
    } else if (e && e.crossLine) {
      go.textContent = '让' + LINE_BY_KEY[ROUTES[e.wantKey].lineKey].short + '列车运行到该站';
      go.disabled = false;
    } else {
      go.textContent = '列车运行到该站';
      go.disabled = !reachable;
    }
  }

  function updateScaleBar() {
    /* 1 km = M.unitsPerKm 地图单位，可直接按当前缩放换算屏幕 px */
    var pxPerKm = view.k * M.unitsPerKm;
    var want = 90 / Math.max(pxPerKm, 1e-6);
    var nice = [0.2, 0.5, 1, 2, 5, 10, 20];
    var km = nice[0];
    for (var i = 0; i < nice.length; i++) if (nice[i] <= want) km = nice[i];
    $('sbFill').style.width = (km * pxPerKm) + 'px';
    $('sbLabel').textContent = km + ' km';
  }

  /* ==================================================== 启动 & 主循环 */
  function init() {
    world = $('world');
    buildBackground(world);
    buildRail();
    buildStations();
    buildLabels();
    initTrains();
    buildTrains();
    buildNextMarks();
    buildStationList();
    resetAllTrains();
    buildLineSelector();
    buildTrainChips();
    buildTrainPills();
    bindControls();
    bindVersionUI();
    resize();
    fitView();
    /* 调试/截图用参数：?adv=秒数 预跑运行模拟, ?follow=1 跟随, ?k=缩放, ?door=1 开门状态 */
    debugParams();
    updateHud();
    applyView();
    ready = true;
    var last = 0, hudAcc = 0;
    function tick(t) {
      var dtRaw = last ? Math.min(0.12, (t - last) / 1000) : 0;   // 切后台回来不跳变
      last = t;
      if (!ready) return;
      var dt = dtRaw * (ui.paused ? 0 : ui.mult);
      if (dt > 0) {
        trains.forEach(function (tr) {
          var left = dt, guard = 0;
          while (left > 1e-6 && guard++ < 12) {      // 大 dt 时拆分子步保证物理稳定
            var sub = Math.min(left, 0.04);
            stepTrain(tr, sub);
            left -= sub;
          }
        });
      }
      /* 自检模式把重绘限到 ~10fps（仿真仍逐帧推进），无头跑得快很多；
         普通模式下每帧都重绘，动画不受影响。 */
      renderAcc += dtRaw;
      if (!SELFTEST_MODE || renderAcc >= 0.1) {
        renderAcc = 0;
        renderTrains();
        updateNextMarks(dtRaw);
        updateTrainPills();
        positionBubbles();
      }
      followStep(dtRaw);
      hudAcc += dtRaw;
      if (hudAcc > 0.12) {
        hudAcc = 0;
        updateHud();
        refreshPopup();
        positionPopup();
        updateTrainChips();
        updateStationList();        // 站点列表的“当前站/目标站”跟着列车走
        scrollListToActive();
      }
    }
    /* 自检模式用 20Hz 定时器（而不是 rAF）驱动：
       无头浏览器在 --virtual-time-budget 下，rAF 会把虚拟时钟拖得很慢，定时器则能快速跑完异步链。 */
    if (SELFTEST_MODE) {
      setInterval(function () { tick(performance.now()); }, 50);
    } else {
      var rafLoop = function (t) { tick(t); requestAnimationFrame(rafLoop); };
      requestAnimationFrame(rafLoop);
    }
    document.addEventListener('visibilitychange', function () {
      last = 0;
      /* 切后台：暂停 BGM（环境声与语音），回来再继续，避免后台放声音 */
      if (document.hidden) {
        if (audio.fileEl && !audio.fileEl.paused) audio.fileEl.pause();
        if (audio.ctx && audio.ctx.state === 'running' && audio.ctx.suspend) audio.ctx.suspend();
        if ('speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) { void e; } }
      } else if (audio.on) {
        if (audio.ctx && audio.ctx.state === 'suspended' && audio.ctx.resume) audio.ctx.resume();
        bgmEnabled(true);
      }
    });
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });
    window.addEventListener('scroll', resize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', resize);
      window.visualViewport.addEventListener('scroll', resize);
    }
    /* 舞台尺寸可能因面板内容变化 / iOS 工具栏变化而改变且不发 resize 事件：
       用 ResizeObserver 保证 viewBox 始终等于真实像素尺寸（否则点站会偏）。 */
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { resize(); }).observe($('stage'));
    }
    setTimeout(resize, 120);
  }

  function resize() {
    var r = $('stage').getBoundingClientRect();
    /* 不做人为最小值：viewBox 必须严格等于元素像素尺寸，否则命中坐标会偏 */
    stage.w = Math.max(1, r.width);
    stage.h = Math.max(1, r.height);
    var m = $('map');
    m.setAttribute('viewBox', '0 0 ' + f1(stage.w) + ' ' + f1(stage.h));
    if (view.fitted) fitView(); else { clampView(); applyView(); updateLabelScale(); }
    updateScaleBar();
    positionPopup();
  }
  /* 调试参数（仅影响本地演示/自动化截图，不影响正常使用） */
  function debugParams() {
    var q = location.search.replace(/^\?/, '');
    if (!q) return;
    var map = {};
    q.split('&').forEach(function (kv) {
      var p = kv.split('=');
      if (p[0]) map[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    if (map.route) {
      if (ROUTES[map.route]) {
        state.routeKey = map.route;
        state.curId = ROUTES[map.route].ids[0];
        state.posKm = ROUTES[map.route].kmAt[0];
        state.nextIdx = 1;
      } else {
        var kk = ROUTE_KEYS.filter(function (k) {
          return ROUTES[k].lineKey === map.route || k === map.route + 'main';
        })[0];
        if (kk) switchService(kk, true);
      }
    }
    if (map.adv) {
      var left = Math.min(parseFloat(map.adv) || 0, 20000);
      while (left > 1e-6) { var sub = Math.min(left, 0.05); stepTrain(state, sub); left -= sub; }
    }
    if (map.door) {
      state.phase = 'dwell'; state.phaseT = CFG.openT + CFG.holdT * 0.5;
      state.v = 0; state.door = 1; state.doorPhase = 'open';
    }
    if (map.follow) setFollow(true);
    if (map.k) zoomAt(stage.w / 2, stage.h / 2, (parseFloat(map.k) || 1) / view.k);
    if (map.target) setTarget(map.target);
    if (map.pop) openPopup(map.pop, null);
    if (map.train) { var ti = parseInt(map.train, 10) - 1; if (setActive(ti)) activateSideEffects(); }
    if (map.sound) setSound(map.sound !== '0');
    if (map.speak) speak(decodeURIComponent(map.speak), true);
    if (map.panel === 'hide') { $('app').classList.add('panel-hidden'); $('btnPanel').textContent = '☰ 控制'; }
  }

  function bindControls() {
    $('btnPlay').addEventListener('click', function () {
      ui.paused = !ui.paused;
      this.textContent = ui.paused ? '▶︎ 继续' : '⏸ 暂停';
      updateHud();
    });
    $('btnReset').addEventListener('click', function () {
      resetState(false);
      setFollow(false);
      closePopup();
      view.fitted = true;
      fitView();
      $('selRoute').value = state.routeKey;
      updateStationList();
      updateHud();
      toast('已复位到起点站：' + M.byId[ROUTES[state.routeKey].origin].zh);
    });
    $('btnClearTarget').addEventListener('click', function () {
      setTarget(null);
      updateStationList();
      toast('已清除目标站');
    });
    $('spClose').addEventListener('click', function () { closePopup(); });
    $('spGo').addEventListener('click', function () {
      if (!popupId) return;
      if (state.target === popupId) setTarget(null);
      else setTarget(popupId);
    });
    $('btnPanel').addEventListener('click', function () {
      var hidden = $('app').classList.toggle('panel-hidden');
      this.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      this.textContent = hidden ? '☰ 控制' : '✕ 收起面板';
      toast(hidden ? '已收起控制面板（点左上“☰ 控制”可展开）' : '控制面板已展开');
      requestAnimationFrame(function () { resize(); });
    });
    $('hud').addEventListener('click', function (e) {
      if (e.target.closest('.hud-brand') || e.target.closest('.hud-fold')) {
        this.classList.toggle('folded');
      }
    });
    $('segSpeed').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      ui.mult = Number(b.getAttribute('data-mult'));
      var all = this.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      recomputeEta();
      updateHud();
    });
    $('btnSound').addEventListener('click', function () { setSound(!audio.on); });
    $('chkFollow').addEventListener('change', function () { setFollow(this.checked); });
    $('selRoute').addEventListener('change', function () {
      var key = this.value;
      if (key === state.routeKey) return;
      switchService(key, false);
      if (ui.follow) followStep(0, true);
      $('selRoute').value = state.routeKey;
      updateHud();
      refreshPopup();
      updateStationList();
    });

    var map = $('map');
    map.addEventListener('pointerdown', onPointerDown);
    map.addEventListener('pointermove', onPointerMove);
    map.addEventListener('pointerup', onPointerUp);
    map.addEventListener('pointercancel', onPointerUp);
    /* iOS 兵底：pointer 事件万一没拿到，用 click 补齐（时间戳去重，不影响拖拽/捏合） */
    map.addEventListener('click', function (e) {
      var now = performance.now();
      if (now - lastTapHandled < 600 || now - lastGestureEnd < 600) return;
      handleTap(localPos(e));
    });
    map.addEventListener('wheel', onWheel, { passive: false });
    map.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    map.addEventListener('dblclick', function (e) { e.preventDefault(); });
  }

  /* ==================================================== 自检（?selftest=1） */
  function selfTest() {
    var out = { checks: [], ok: true };
    function chk(name, cond, detail) {
      out.checks.push({ name: name, pass: !!cond, detail: detail === undefined ? '' : detail });
      if (!cond) out.ok = false;
    }
    var names = M.stations.map(function (s) { return s.zh; });
    var expectL1 = ['韦家碾', '升仙湖', '火车北站', '人民北路', '文殊院', '骡马市', '天府广场', '锦江宾馆', '华西坝',
      '省体育馆', '倪家桥', '桐梓林', '火车南站', '高新', '金融城', '孵化园', '锦城广场', '世纪城', '天府三街',
      '天府五街', '华府大道', '四河', '华阳', '海昌路', '广福', '红石公园', '麓湖', '武汉路', '天府公园', '西博城',
      '广州路', '兴隆湖', '科学城'];
    var expectL2 = ['犀浦', '天河路', '百草路', '金周路', '金科北路', '迎宾大道', '茶店子客运站', '羊犀立交',
      '一品天下', '蜀汉路东', '白果林', '中医大·省医院', '通惠门', '人民公园', '天府广场', '春熙路', '东门大桥',
      '牛王庙', '牛市口', '东大路', '塔子山公园', '成都东客站', '成渝立交', '惠王陵', '洪河', '成都行政学院',
      '龙泉驿火车站', '大面铺', '连山坡', '界牌', '书房', '龙平路', '龙泉驿'];
    function zh(key) { return ROUTES[key].ids.map(function (id) { return M.byId[id].zh; }); }
    chk('站点总数 = 67（1 号线 35 + 2 号线 33 − 天府广场共用 1）', M.stations.length === 67, M.stations.length);
    chk('站名无重复', new Set(names).size === names.length);
    chk('1 号线主线顺序 = 官方列表（韦家碾→科学城）', zh('1main').join(',') === expectL1.join(','), zh('1main').length);
    chk('1 号线支线顺序 = 韦家碾…四河,广都,五根松',
      zh('1branch').join(',') === expectL1.slice(0, 22).concat(['广都', '五根松']).join(','), zh('1branch').length);
    chk('2 号线顺序 = 官方列表（犀浦→龙泉驿，含在建站）', zh('2main').join(',') === expectL2.join(','), zh('2main').length);
    chk('天府广场是 1/2 号线唯一换乘站', (function () {
      var shared = M.stations.filter(function (s) { return s.lines && s.lines.length > 1; });
      return shared.length === 1 && shared[0].id === 'tianfuguangchang';
    })(), M.stations.filter(function (s) { return s.lines && s.lines.length > 1; }).length + ' 个');
    chk('1 号线里程 ≈ 37.5 km（OSM 轨道弧长）', Math.abs(ROUTES['1main'].kmLength - 37.45) < 0.6, f2(ROUTES['1main'].kmLength));
    chk('2 号线里程 ≈ 41.7 km', Math.abs(ROUTES['2main'].kmLength - 41.66) < 0.8, f2(ROUTES['2main'].kmLength));
    chk('起点站里程 = 0', ROUTES['1main'].kmAt[0] < 0.02 && ROUTES['2main'].kmAt[0] < 0.02,
      f2(ROUTES['1main'].kmAt[0]) + ' / ' + f2(ROUTES['2main'].kmAt[0]));
    chk('1 号线主线+支线合计 ≈ 41 km（官方口径）',
      Math.abs(ROUTES['1main'].kmLength + (ROUTES['1branch'].kmLength -
        ROUTES['1branch'].kmAt[ROUTES['1branch'].ids.indexOf('sihe')]) - 40.3) < 1.0,
      f2(ROUTES['1main'].kmLength + ROUTES['1branch'].kmLength -
        ROUTES['1branch'].kmAt[ROUTES['1branch'].ids.indexOf('sihe')]));

    /* 站点位置必须落在路径上、里程单调 */
    var onLine = true, mono = true, maxProj = 0, worstOn = '', worstOnD = 0;
    ROUTE_KEYS.forEach(function (key) {
      var r = ROUTES[key];
      maxProj = Math.max(maxProj, r.projErr);
      r.ids.forEach(function (id, i) {
        var p = pointAt(r, r.mapAt[i]);
        var d = Math.hypot(p.x - M.byId[id].x, p.y - M.byId[id].y);
        if (d > worstOnD) { worstOnD = d; worstOn = M.byId[id].zh + '@' + key; }
        if (d > 1.0) onLine = false;
        if (i && r.kmAt[i] <= r.kmAt[i - 1]) mono = false;
      });
    });
    chk('全部站点均落在路径上（偏差 < 1 单位；分叉站四河因道岙几何略偏）', onLine, worstOn + ' 最大 ' + f2(worstOnD) + ' 单位');
    chk('站点到轨道最大投影误差 < 1 m', maxProj < 1.0, f2(maxProj) + ' m');
    chk('站点里程单调递增', mono);
    chk('端点在路径两端（含折返线延长段）',
      ROUTES['1main'].mapAt[0] > 40 && ROUTES['2main'].mapAt[0] > 40 &&
      ROUTES['1main'].mapAt[ROUTES['1main'].mapAt.length - 1] < ROUTES['1main'].length - 40);

    /* 列车几何：车体轮廓顶点到路径的距离应等于设计半宽 */
    var maxErr = 0;
    (function () {
      var route = ROUTES['1main'], s = route.mapAt[10];
      var d = bandPath(route, s, s - CFG.carLen, 0, CFG.carHW, 14, function () { return 1; });
      var nums = d.replace(/[MZ]/g, ' ').split('L').join(' ').trim().split(/\s+/).map(Number);
      for (var i = 0; i + 1 < nums.length; i += 2) {
        var px = nums[i], py = nums[i + 1];
        var best = Infinity;
        for (var t = 0; t <= 400; t++) {
          var q = pointAt(route, s - CFG.carLen * t / 400);
          best = Math.min(best, Math.hypot(q.x - px, q.y - py));
        }
        maxErr = Math.max(maxErr, Math.abs(best - CFG.carHW));
      }
    })();
    chk('车体轮廓与线路中心线距离 = 半宽（<0.25）', maxErr < 0.25, f2(maxErr));

    /* 全程运行（1 号线主线）：逐站停靠、不超速、终点折返 */
    var sim = cloneState();
    sim.phase = 'dwell'; sim.phaseT = 0;
    var t = 0, stops = [], vmaxSeen = 0, reversed = false, dir0 = sim.dir;
    while (t < 20000) {
      stepTrain(sim, 0.25); t += 0.25;
      vmaxSeen = Math.max(vmaxSeen, sim.v);
      if (sim.phase === 'dwell' && sim.phaseT < 0.3 && stops[stops.length - 1] !== sim.curId) stops.push(sim.curId);
      if (sim.dir !== dir0) { reversed = true; break; }
    }
    chk('1 号线全程依次停靠 33 站', stops.length === 33 && stops[32] === 'kexuecheng', stops.length + ' 站，末站 ' + (stops[32] || '-'));
    chk('不超过区间限速 60 km/h', vmaxSeen <= CFG.vmax + 1e-6, f2(vmaxSeen));
    chk('到达终点后折返换向', reversed, '折返后方向 ' + sim.dir + '，当前站 ' + (sim.curId ? M.byId[sim.curId].zh : '-'));
    chk('1 号线全程仿真时长合理（< 90 分钟）', t < 5400, f2(t / 60) + ' 分钟');

    /* 2 号线全程：在营 32 站停靠，在建的龙泉驿火车站不停靠 */
    var sim2l = cloneState();
    sim2l.routeKey = '2main'; sim2l.curId = 'xipu'; sim2l.posKm = 0; sim2l.dir = 1;
    sim2l.phase = 'dwell'; sim2l.phaseT = 0; sim2l.nextIdx = 1; sim2l.target = null;
    var t2l = 0, stops2 = [];
    while (t2l < 20000) {
      stepTrain(sim2l, 0.25); t2l += 0.25;
      if (sim2l.phase === 'dwell' && sim2l.phaseT < 0.3 && stops2[stops2.length - 1] !== sim2l.curId) stops2.push(sim2l.curId);
      if (stops2.length >= 33 || sim2l.dir !== 1) break;
    }
    chk('2 号线全程停靠 32 站（跳过在建站）',
      stops2.length === 32 && stops2[31] === 'longquanyi' && stops2.indexOf('longquanyihuochezhan') < 0,
      stops2.length + ' 站，末站 ' + (stops2[31] ? M.byId[stops2[31]].zh : '-'));
    chk('2 号线全程仿真时长合理（< 100 分钟）', t2l < 6000, f2(t2l / 60) + ' 分钟');
    chk('在建站不能作为目标站', (function () {
      var bak = state.target;
      setTarget('longquanyihuochezhan');
      var bad = state.target === 'longquanyihuochezhan';
      state.target = bak;
      return !bad;
    })(), (function () { var e = etaFor('longquanyihuochezhan'); return e ? e.reason : 'n/a'; })());

    /* 目标站导航：支线站点（需在四河切换交路） */
    var sim2 = cloneState();
    sim2.target = 'wugensong';
    var t2 = 0, hits = 0, rev2 = false;
    while (t2 < 20000 && hits < 1) {
      stepTrain(sim2, 0.25); t2 += 0.25;
      if (sim2.curId === 'wugensong' && sim2.phase === 'dwell') hits++;
      if (sim2.phase === 'reverse') rev2 = true;
    }
    chk('点击支线站（五根松）可到达并在四河换交路',
      hits === 1 && sim2.routeKey === '1branch', '耗时 ' + fmtDur(t2) + '，交路 ' + sim2.routeKey);

    /* 跨线路：交给跑那条线的那列车（不瞬移当前车） */
    chk('跨线路目标交给跑那条线的列车（不瞬移当前车）', (function () {
      var bak0 = snap(trains[0]), bak1 = snap(trains[1]), bakActive = activeIdx;
      setActive(0);
      var p0 = trains[0].posKm, p1 = trains[1].posKm;
      setTarget('chunxilu');                        // 2 号线车站
      var ok = activeIdx === 1 && trains[1].target === 'chunxilu' &&
        Math.abs(trains[0].posKm - p0) < 1e-9 && Math.abs(trains[1].posKm - p1) < 1e-9 &&
        ROUTES[trains[1].routeKey].lineKey === '2';
      chk.__xl = 'active=' + activeIdx + ' 1号线位移=' + Math.abs(trains[0].posKm - p0).toFixed(3) +
        ' 2号线位移=' + Math.abs(trains[1].posKm - p1).toFixed(3);
      restore(trains[0], bak0); restore(trains[1], bak1);
      setActive(bakActive);
      return ok;
    })(), chk.__xl);

    /* 后方站点：需要折返 */
    var sim3 = cloneState();
    sim3.routeKey = '1main'; sim3.dir = 1; sim3.posKm = stationKm('huochenanzhan');
    sim3.curId = 'huochenanzhan'; sim3.phase = 'dwell'; sim3.phaseT = 0; sim3.nextIdx = 14;
    sim3.target = 'tianfuguangchang';
    var t3 = 0, seenReverse = false, ok3 = false;
    while (t3 < 20000) {
      stepTrain(sim3, 0.25); t3 += 0.25;
      if (sim3.phase === 'reverse') seenReverse = true;
      if (seenReverse && sim3.curId === 'tianfuguangchang' && sim3.phase === 'dwell') { ok3 = true; break; }
    }
    chk('目标在身后时先到终点折返再抵达', ok3, '折返=' + seenReverse + ' 耗时 ' + fmtDur(t3));

    /* ETA 与实际仿真一致（±1s） */
    var simEta = cloneState();
    simEta.target = 'xibocheng';
    var te = 0;
    while (te < 20000) { stepTrain(simEta, 0.25); te += 0.25; if (simEta.curId === 'xibocheng' && simEta.phase === 'dwell') break; }
    var savedTarget = state.target;
    state.target = 'xibocheng';
    recomputeEta();
    var etaErr = Math.abs(state.eta - te);
    state.target = savedTarget;
    chk('预计到达(ETA)与实际仿真误差 < 2s', etaErr < 2, f2(etaErr) + 's');

    /* 视图：缩放到最小/最大后内容仍在可视范围 */
    var saved = { k: view.k, tx: view.tx, ty: view.ty };
    view.k = minZoom(); clampView();
    var c = contentBox();
    var cx = (c.x0 + c.x1) / 2 * view.k + view.tx, cy = (c.y0 + c.y1) / 2 * view.k + view.ty;
    chk('最小缩放下线路仍居中可见', Math.abs(cx - stage.w / 2) < 2 && Math.abs(cy - stage.h / 2) < 2,
      'cx=' + f2(cx) + ' cy=' + f2(cy) + ' stage=' + f2(stage.w) + 'x' + f2(stage.h) + ' k=' + f2(view.k));
    view.k = 16; clampView();
    chk('最大缩放被限制在 16x', view.k <= 16, f2(view.k));
    var c2 = panBox();
    chk('放大后可视窗口仍落在线路范围内',
      c2.x0 * view.k + view.tx <= stage.w && c2.x1 * view.k + view.tx >= 0 &&
      c2.y0 * view.k + view.ty <= stage.h && c2.y1 * view.k + view.ty >= 0,
      'x=[' + f2(c2.x0 * view.k + view.tx) + ',' + f2(c2.x1 * view.k + view.tx) + '] y=[' +
      f2(c2.y0 * view.k + view.ty) + ',' + f2(c2.y1 * view.k + view.ty) + '] stage=' + f2(stage.w) + 'x' + f2(stage.h));
    view.k = saved.k; view.tx = saved.tx; view.ty = saved.ty; clampView(); applyView();

    /* 标签防重叠：统计可见标签中互相遮挡的比例 */
    updateLabelScale();
    var worst = 0, bad = [], totalArea = 0;
    labelBoxes.forEach(function (b) {
      var a = b.w * b.h;
      totalArea += a;
      var mx = 0;
      labelBoxes.forEach(function (o) {
        if (o === b) return;
        mx = Math.max(mx, overlapArea(b, o) / a);
      });
      if (mx > worst) worst = mx;
      if (mx > 0.25) bad.push(M.byId[b.stId].zh + ':' + mx.toFixed(2));
    });
    chk('可见站名标签无明显重叠（最大遮挡 < 25%）', bad.length === 0,
      '可见 ' + labelBoxes.length + ' 个标签，最差遮挡 ' + (worst * 100).toFixed(1) + '%' + (bad.length ? ' 超标: ' + bad.join(',') : ''));

    chk('刷新 URL 构造：保留原有查询参数（如 selftest=1）且含 _v=', (function () {
      var out = refreshUrlFor('https://x.test/chengdu-metro-line1/index.html?selftest=1&foo=bar#h', 1234567890);
      chk.__u1 = out;
      return /[?&]_v=1234567890/.test(out) && /selftest=1/.test(out) && /foo=bar/.test(out) &&
        /#h$/.test(out) && out.indexOf('/chengdu-metro-line1/index.html') === 0;
    })(), chk.__u1);

    chk('刷新 URL 会替换旧的 _v（不重复累加）', (function () {
      var a = refreshUrlFor('https://x.test/chengdu-metro-line1/index.html?_v=111&selftest=1', 222);
      chk.__u2 = a;
      return /_v=222/.test(a) && !/_v=111/.test(a) && /selftest=1/.test(a);
    })(), chk.__u2);

    chk('「检查更新」按钮在 HTML 面板层、≥44px、可点击', (function () {
      var b = $('btnRefresh');
      if (!b) return false;
      var r = b.getBoundingClientRect();
      return b.closest('#panel') !== null && b.tagName === 'BUTTON' && r.height >= 44 && r.width >= 44;
    })(), (function () {
      var b = $('btnRefresh'), r = b ? b.getBoundingClientRect() : { width: 0, height: 0 };
      return 'inPanel=' + (!!b && b.closest('#panel') !== null) + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height);
    })());

    chk('版本戳元素存在且内容非空（角落徽标 + 面板行）', (function () {
      var t = $('verText'), b = $('verBadge');
      return !!t && !!b && t.textContent.trim().length > 0 && b.textContent.trim().length > 0 && /^v/.test(b.textContent.trim());
    })(), 'panel="' + $('verText').textContent + '" corner="' + $('verBadge').textContent + '"');

    chk('版本戳已从 version.json 读取（http 环境）', (function () {
      var http = location.protocol === 'http:' || location.protocol === 'https:';
      if (!http) return true;                        // file:// 下 fetch 不可用，跳过
      return !!(BUILD_VERSION && BUILD_VERSION.version) && /^\d{4}-\d{2}-\d{2}/.test(BUILD_VERSION.version) &&
        /v\d{4}-\d{2}-\d{2}/.test($('verBadge').textContent);
    })(), BUILD_VERSION ? (BUILD_VERSION.version + ' · ' + BUILD_VERSION.commit) : '未读取');

    chk('点击「检查更新」不会把页面弄坏（已是最新时不重载）', (function () {
      var before = location.href;
      checkUpdate(false);
      return location.href === before;               // 同版本时只提示，不跳转
    })());

    chk('左上角「⟳ 刷新」按钮：在 HTML 层、左上角、≥44px、可点击', (function () {
      var b = $('btnHardRefresh');
      if (!b) return false;
      var r = b.getBoundingClientRect();
      var st = $('stage').getBoundingClientRect();
      var hud = $('hud').getBoundingClientRect();
      var overlapped = !(r.right <= hud.left - 1 || r.left >= hud.right + 1 || r.bottom <= hud.top - 1 || r.top >= hud.bottom + 1);
      chk.__hr = 'inHTML=' + (b.closest('#stage') !== null) + ' pos=(' + Math.round(r.left - st.left) + ',' + Math.round(r.top - st.top) +
        ') size=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' 与HUD不重叠=' + !overlapped;
      return b.closest('#stage') !== null && b.tagName === 'BUTTON' && r.height >= 44 && r.width >= 44 &&
        (r.left - st.left) < 120 && (r.top - st.top) < 120 && !overlapped;
    })(), chk.__hr);

    chk('点「⟳ 刷新」= 强制整页重拉（cache-busting 地址，用桩验证不真跳转）', (function () {
      resetReloadBudget();
      hardReload(function () { /* 桩：不真跳转 */ });
      var url = lastReloadUrl;
      var ok = !!url && /[?&]_v=\d+/.test(url) && url.indexOf(location.pathname) === 0;
      if (location.search) {
        var key = location.search.replace(/^\?/, '').split('&')[0].split('=')[0];
        ok = ok && url.indexOf(key + '=') >= 0;
      }
      chk.__hr2 = '刷新地址("' + String(url) + '")';
      return ok;
    })(), chk.__hr2);

    chk('资源按版本号加载（防 Pages 10 分钟缓存）', (function () {
      var scripts = document.querySelectorAll('script[src]');
      var srcs = Array.prototype.map.call(scripts, function (s) { return s.getAttribute('src'); });
      var hasApp = srcs.some(function (s) { return /app\.js/.test(s); });
      var versioned = srcs.some(function (s) { return /app\.js\?v=/.test(s); });
      chk.__ver = 'scripts=' + srcs.join(' ');
      /* file:// 下拿不到版本号时按原路径加载也算通过 */
      var offline = location.protocol !== 'http:' && location.protocol !== 'https:';
      return hasApp && (versioned || offline);
    })(), chk.__ver);

    /* 回归：本轮的 reported bug（探路不瞬移 / 列表跟随 / 报站 / 定位不死循环） */
    chk('同线路目标不改交路、不重置位置（由四河自然换交路）', (function () {
      var bak = snap(state), bakActive = activeIdx, bakRoute = state.routeKey;
      setActive(0);
      state.routeKey = '1main';
      var p = state.posKm;
      setTarget('guangdu');                        // 支线车站
      var ok = state.routeKey === '1main' && Math.abs(state.posKm - p) < 1e-9 && state.target === 'guangdu';
      chk.__np2 = 'routeKey=' + state.routeKey + ' 位移=' + Math.abs(state.posKm - p).toFixed(3);
      setTarget(null); restore(state, bak); state.routeKey = bakRoute; setActive(bakActive);
      return ok;
    })(), chk.__np2);

    chk('到站/关门/发车三个时机都有报站（字幕 + 语音计数递增）', (function () {
      var bak = snap(state), bakAudio = audio.on;
      var ann0 = audio.announcements, seen = [];
      setSound(true);
      state.aOpened = false; state.aClosing = false; state.aDepart = false;
      state.phase = 'dwell'; state.phaseT = 0; state.door = 0;
      for (var i = 0; i < 400 && state.phase === 'dwell'; i++) {
        stepTrain(state, 0.05);
        var b = document.getElementById('announce');
        if (b && b.textContent && seen.indexOf(b.textContent) < 0) seen.push(b.textContent);
      }
      var ok = seen.length >= 3 && audio.announcements > ann0 &&
        seen.some(function (t) { return /站到了/.test(t); }) &&
        seen.some(function (t) { return /车门即将关闭/.test(t); }) &&
        seen.some(function (t) { return /下一站/.test(t); });
      chk.__ann3 = seen.length + ' 条字幕 · 语音计数 ' + ann0 + '→' + audio.announcements + ' · ' +
        seen.map(function (t) { return t.slice(0, 9); }).join('/');
      setSound(bakAudio);
      restore(state, bak);
      return ok;
    })(), chk.__ann3);

    chk('气泡/列车标签定位有界（贴边不会卡死）', (function () {
      var t0 = performance.now();
      for (var i = 0; i < 20; i++) positionBubbles();
      var ms = performance.now() - t0;
      chk.__perf = '20 次 positionBubbles = ' + ms.toFixed(1) + ' ms';
      return ms < 500;
    })(), chk.__perf);

    chk('站点列表跟随当前列车（当前站高亮、目标站标出）', (function () {
      updateStationList();
      var box = $('stlist');
      var here = box.querySelectorAll('button.here');
      var b = box.querySelector('[data-st="' + state.curId + '"]');
      chk.__lst = '当前站=' + state.curId + ' here数=' + here.length + ' 高亮=' + (!!b && b.classList.contains('here'));
      return here.length === 1 && !!b && b.classList.contains('here');
    })(), chk.__lst);

    chk('渲染元素齐备（67 车站 / 67 标签 / 2 列车×8 车厢）',
      Object.keys(stationEls).length === 67 && labelEls.length === 67 &&
      trainGroups.length === 2 && trainGroups.every(function (g) { return g.els.length === 8; }),
      Object.keys(stationEls).length + '/' + labelEls.length + '/' + trainGroups.length + '×' +
        (trainGroups[0] ? trainGroups[0].els.length : 0));

    chk('每列车 8 节车厢，且整列车能停在端点折返段内',
      CFG.cars === 8 && trainGroups.every(function (g) { return g.els.length === 8; }) &&
      (CFG.cars * CFG.carLen + (CFG.cars - 1) * CFG.carGap) < CFG.stub,
      '车长合计 ' + f2(CFG.cars * CFG.carLen + (CFG.cars - 1) * CFG.carGap) + ' < 折返段 ' + CFG.stub);

    chk('停站时间 = 10 秒（开门 1.2 + 上下客 7.0 + 关门 1.2 + 待发 0.6）',
      Math.abs(CFG.openT + CFG.holdT + CFG.closeT + CFG.readyT - 10) < 0.01,
      f2(CFG.openT + CFG.holdT + CFG.closeT + CFG.readyT) + ' s');

    chk('停站时长在仿真中生效（到站→发车 = 10 s）', (function () {
      var tr = cloneTrainState(trains[0]);
      var r = ROUTES[tr.routeKey];
      tr.phase = 'dwell'; tr.phaseT = 0; tr.door = 0; tr.doorPhase = 'opening';
      tr.dir = 1; tr.nextIdx = clamp(r.ids.indexOf(tr.curId) + 1, 0, r.ids.length - 1);
      tr.aOpened = true; tr.aClosing = true; tr.aDepart = true;      // 自检不报站
      var t = 0, guard = 0;
      while (guard++ < 3000 && tr.phase === 'dwell') { stepTrain(tr, 0.05); t += 0.05; }
      chk.__dwell = f2(t) + ' s';
      return Math.abs(t - 10) < 0.12;
    })(), chk.__dwell);

    chk('声音：默认关闭（不违反自动播放策略）且开关按钮在面板层、≥44px', (function () {
      var b = $('btnSound');
      var r = b ? b.getBoundingClientRect() : { width: 0, height: 0 };
      chk.__snd = 'text=' + (b ? b.textContent.trim() : '-') + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' on=' + audio.on;
      return !!b && b.closest('#panel') !== null && r.height >= 44 && r.width >= 44 && audio.on === false;
    })(), chk.__snd);

    chk('报站文案（到站/关门/发车）包含站名与关键提示', (function () {
      var a = announceText('arrive', { zh: '文殊院', next: '骡马市', line: '1' });
      var c = announceText('closing', { zh: '文殊院' });
      var d = announceText('depart', { zh: '文殊院', next: '骡马市', line: '1' });
      chk.__ann = a;
      return a.indexOf('文殊院') >= 0 && a.indexOf('站到了') >= 0 && c.indexOf('车门即将关闭') >= 0 &&
        d.indexOf('下一站') >= 0 && d.indexOf('骡马市') >= 0;
    })(), chk.__ann);

    chk('开启声音：音频上下文与合成 BGM/铃音通道就绪，关闭后还原', (function () {
      var hasAC = typeof (window.AudioContext || window.webkitAudioContext) === 'function';
      if (!hasAC) return true;                              // 环境不支持就跳过
      setSound(true);
      var ok = audio.on === true && !!audio.ctx && !!audio.bgmGain && !!audio.synth &&
        /开/.test($('btnSound').textContent);
      setSound(false);
      chk.__aud = 'ctx=' + !!audio.ctx + ' synth=' + !!audio.synth + ' bgmGain=' + !!audio.bgmGain +
        ' 已还原=' + (audio.on === false);
      return ok && audio.on === false;
    })(), chk.__aud);

    chk('列车强调显示：每列车有光晕 + 跟随标签（带线路与状态）', (function () {
      var halos = document.querySelectorAll('#trains .train-halo path');
      var pills = document.querySelectorAll('#trainpills .tp');
      var hasState = Array.prototype.every.call(pills, function (p) { return p.textContent.trim().length > 2; });
      chk.__emp = halos.length + ' 光晕 / ' + pills.length + ' 标签 / ' + hasState;
      return halos.length === 2 * CFG.cars && pills.length === 2 && hasState &&
        document.querySelectorAll('#trainpills .tp.on').length === 1;
    })(), chk.__emp);

    /* ================= 多列车：自动运行 / 可点击切换 / 下一站强调与气泡 ================= */
    function snap(tr) {
      var o = {};
      ['routeKey', 'dir', 'posKm', 'v', 'phase', 'phaseT', 'doorPhase', 'door', 'curId',
        'nextIdx', 'target', 'odometer', 'eta', 'etaStops'].forEach(function (k) { o[k] = tr[k]; });
      return o;
    }
    function restore(tr, o) { for (var k in o) tr[k] = o[k]; }
    function simAdvance(sec) {
      var t = 0;
      while (t < sec) {
        trains.forEach(function (tr) { stepTrain(tr, 0.05); });
        t += 0.05;
      }
    }

    chk('列车数 = 每条线路 1 列（共 2 列）', trains.length === 2 &&
      ROUTES[trains[0].routeKey].lineKey === '1' && ROUTES[trains[1].routeKey].lineKey === '2',
      trains.map(function (t) { return LINE_BY_KEY[ROUTES[t.routeKey].lineKey].short; }).join(' / '));

    chk('打开页面后所有列车自动运行（前进 300s 两列车都位移 > 0.5 km）', (function () {
      var bak = trains.map(snap);
      trains.forEach(function (tr) { resetTrain(tr, false); });
      simAdvance(300);
      var moved = trains.every(function (tr) { return tr.odometer > 0.5; });
      var detail = trains.map(function (tr) { return tr.odometer.toFixed(2) + 'km'; }).join(' / ');
      trains.forEach(function (tr, i) { restore(tr, bak[i]); });
      chk.__moved = detail;
      return moved;
    })(), chk.__moved);

    chk('点击列车可切换当前控制列车（面板/交路/HUD 同步）', (function () {
      var bakActive = activeIdx, bakSel = $('selRoute').value;
      var tr1 = trains[1], route = ROUTES[tr1.routeKey];
      var p = pointAt(route, kmToMap(route, tr1.posKm));
      var hit = hitTrain({ x: p.x * view.k + view.tx, y: p.y * view.k + view.ty });
      setActive(1);
      activateSideEffects();
      var ok = hit === 1 && activeIdx === 1 && $('selRoute').value === tr1.routeKey &&
        /2号线/.test($('hudDir').textContent) && document.querySelectorAll('#trainChips .tchip.on').length === 1;
      var detail = 'hitTrain=' + hit + ' active=' + activeIdx + ' select=' + $('selRoute').value +
        ' hud="' + $('hudDir').textContent + '"';
      setActive(bakActive);
      activateSideEffects();
      $('selRoute').value = bakSel;
      chk.__act = detail;
      return ok;
    })(), chk.__act);

    chk('当前控制列车有选中标识（虚线环 + 加粗描边）', (function () {
      var g = document.querySelectorAll('#trains .train');
      return g.length === 2 && g[activeIdx].classList.contains('active') &&
        !g[1 - activeIdx].classList.contains('active');
    })());

    chk('每列车下一站都有强调圈与到站气泡（含量化时间）', (function () {
      etaCache = [];
      updateNextMarks();
      var wraps = Object.keys(bubbleWraps).length;
      var bubbles = document.querySelectorAll('.ntb');
      var rings = document.querySelectorAll('.next-ring');
      var hasTime = Array.prototype.some.call(bubbles, function (b) { return /秒|分/.test(b.textContent); });
      var visible = Array.prototype.every.call(document.querySelectorAll('.next-ring'), function (c) {
        return c.style.display !== 'none' && c.getAttribute('cx') !== null;
      });
      chk.__bub = wraps + ' 站 / ' + bubbles.length + ' 气泡 / ' + rings.length + ' 圈 / ' + hasTime;
      return wraps >= 1 && bubbles.length >= 2 && rings.length === 2 && hasTime && visible;
    })(), chk.__bub);

    chk('同一站点多列车 → 气泡折叠为一条，点击展开全部，点空白收起', (function () {
      var a = trains[0], b = trains[1], bak = [snap(a), snap(b), activeIdx];
      var r1 = ROUTES['1main'], r2 = ROUTES['2main'];
      var i1 = r1.ids.indexOf('tianfuguangchang'), i2 = r2.ids.indexOf('tianfuguangchang');
      a.routeKey = '1main'; a.curId = r1.ids[i1 - 1]; a.nextIdx = i1;
      a.posKm = r1.kmAt[i1] - 0.45; a.dir = 1; a.phase = 'run'; a.v = 40;
      b.routeKey = '2main'; b.curId = r2.ids[i2 - 1]; b.nextIdx = i2;
      b.posKm = r2.kmAt[i2] - 0.45; b.dir = 1; b.phase = 'run'; b.v = 40;
      etaCache = [];
      updateNextMarks();
      var wrap = bubbleWraps['tianfuguangchang'];
      var collapsed = !!wrap && wrap.classList.contains('multi') && !wrap.classList.contains('expanded') &&
        wrap.querySelectorAll('.ntb').length === 1 && /2 趟/.test(wrap.textContent);
      if (wrap) wrap.querySelector('.ntb').click();
      var expanded = !!wrap && wrap.classList.contains('expanded') && wrap.querySelectorAll('.ntb').length === 2;
      /* 找一个离两列车都远的空白点，验证“点空白收起” */
      var pts = [[6, 6], [stage.w - 6, 6], [6, stage.h - 6], [stage.w - 6, stage.h - 6]];
      var far = null, farD = -1;
      pts.forEach(function (q) {
        var d = 1e9;
        trains.forEach(function (tr) {
          var route = ROUTES[tr.routeKey], sh = kmToMap(route, tr.posKm);
          for (var i = 0; i < CFG.cars; i++) {
            var c = pointAt(route, sh - tr.dir * (i * (CFG.carLen + CFG.carGap) + CFG.carLen / 2));
            d = Math.min(d, Math.hypot(c.x * view.k + view.tx - q[0], c.y * view.k + view.ty - q[1]));
          }
        });
        if (d > farD) { farD = d; far = { x: q[0], y: q[1] }; }
      });
      if (far && farD > 40) handleTap(far);
      var collapsed2 = !!wrap && !wrap.classList.contains('expanded');
      restore(a, bak[0]); restore(b, bak[1]); setActive(bak[2]); activateSideEffects();
      etaCache = []; updateNextMarks();
      chk.__fold = 'fold=' + collapsed + ' expand=' + expanded + ' away=' + collapsed2 + ' blankDist=' + Math.round(farD);
      return collapsed && expanded && collapsed2;
    })(), chk.__fold);

    var pre = document.getElementById('selftest') || document.createElement('pre');
    pre.id = 'selftest';
    pre.textContent = JSON.stringify(out, null, 1);
    if (!pre.parentNode) document.body.appendChild(pre);
    document.title = (out.ok ? 'SELFTEST-PASS' : 'SELFTEST-FAIL') + ' ' +
      out.checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }).join('|');
    return out;
  }

  /* 触摸交互自检：合成 PointerEvent 驱动真实的处理函数 */
  function selfTestInteraction(chk, done) {
    var map = $('map'), r = map.getBoundingClientRect();
    function pe(type, x, y, id) {
      map.dispatchEvent(new PointerEvent(type, {
        pointerId: id, clientX: r.left + x, clientY: r.top + y,
        bubbles: true, cancelable: true, isPrimary: id < 20, pointerType: 'touch'
      }));
    }
    var st = M.byId.xibocheng;
    var sp = { x: st.x * view.k + view.tx, y: st.y * view.k + view.ty };
    chk('站点命中半径 ≥ 44px（直径）', CFG.tapRadius * 2 >= 44, CFG.tapRadius * 2 + 'px');
    chk('命中测试能命中车站圆心', hitStation(sp) === 'xibocheng', String(hitStation(sp)));

    setTarget(null);
    closePopup();
    pe('pointerdown', sp.x, sp.y, 11); pe('pointerup', sp.x, sp.y, 11);
    setTimeout(function () {
      chk('单击站点 → 弹出站点悬浮窗', $('stpop').hidden === false && popupId === 'xibocheng',
        'popupId=' + String(popupId));
      chk('悬浮窗含到达时间与列车状态',
        /秒|已在该站/.test($('spEta').textContent) && $('spState').textContent.length > 2,
        'eta="' + $('spEta').textContent + '" state="' + $('spState').textContent + '"');
      chk('悬浮窗未超出舞台边界', (function () {
        var b = $('stpop').getBoundingClientRect(), s = $('stage').getBoundingClientRect();
        return b.left >= s.left - 1 && b.top >= s.top - 1 && b.right <= s.right + 1 && b.bottom <= s.bottom + 1;
      })(), (function () {
        var b = $('stpop').getBoundingClientRect(), s = $('stage').getBoundingClientRect();
        return 'pop=[' + Math.round(b.left) + ',' + Math.round(b.top) + ',' + Math.round(b.right) + ',' + Math.round(b.bottom) +
          '] stage=[' + Math.round(s.left) + ',' + Math.round(s.top) + ',' + Math.round(s.right) + ',' + Math.round(s.bottom) + ']';
      })());
      chk('悬浮窗到达时间与实际仿真一致（±2s）', (function () {
        var e = etaFor('xibocheng');
        if (!e || !e.ok) return false;
        var sim = cloneState(); sim.target = 'xibocheng';
        var t = 0;
        while (t < 20000) { stepTrain(sim, 0.25); t += 0.25; if (sim.curId === 'xibocheng' && sim.phase === 'dwell') break; }
        return Math.abs(e.seconds - t) < 2;
      })(), 'eta=' + (function () { var e = etaFor('xibocheng'); return e && e.ok ? fmtDur(e.seconds) : 'n/a'; })());
      var popIdBefore = popupId;
      setTarget(null);
      zoomAt(stage.w / 2, stage.h / 2, 3 / view.k);      // 先放大，否则全景下平移本就被约束
      var tx0 = view.tx, ty0 = view.ty;
      pe('pointerdown', sp.x, sp.y, 12);
      pe('pointermove', sp.x + 40, sp.y + 55, 12);
      pe('pointermove', sp.x + 75, sp.y + 95, 12);
      pe('pointerup', sp.x + 75, sp.y + 95, 12);
      setTimeout(function () {
        chk('单指拖动 → 平移且不误触发站点点击',
          Math.abs(view.tx - tx0) > 30 && popupId === popIdBefore,
          'dx=' + f2(view.tx - tx0) + ', popup=' + String(popupId));
        var k0 = view.k;
        pe('pointerdown', 300, 300, 21); pe('pointerup', 300, 300, 21);
        pe('pointerdown', 302, 301, 22); pe('pointerup', 302, 301, 22);
        setTimeout(function () {
          chk('双击 → 以点击点为锚放大', view.k > k0 * 1.6, f2(k0) + ' → ' + f2(view.k));
          var k1 = view.k, ax = 400, ay = 300;
          pe('pointerdown', ax - 50, ay, 31); pe('pointerdown', ax + 50, ay, 32);
          pe('pointermove', ax - 100, ay, 31); pe('pointermove', ax + 100, ay, 32);
          pe('pointerup', ax - 100, ay, 31); pe('pointerup', ax + 100, ay, 32);
          chk('双指捏合 → 以两指中点为锚放大约 2x', view.k > k1 * 1.7, f2(k1) + ' → ' + f2(view.k));
          zoomAt(0, 0, 0.001);
          chk('缩放下限受约束', view.k >= minZoom() - 1e-9, f2(view.k) + ' >= ' + f2(minZoom()));
          zoomAt(0, 0, 1e6);
          chk('缩放上限受约束（≤ 16x）', view.k <= 16 + 1e-9, f2(view.k));
          chk('平移范围受约束（线路不会滑出屏幕）', (function () {
            view.tx += 99999; clampView();
            var c = panBox(), ok1 = c.x0 * view.k + view.tx <= stage.w + 0.5;
            view.tx -= 199999; clampView();
            var ok2 = c.x1 * view.k + view.tx >= -0.5;
            return ok1 && ok2;
          })(), 'x=' + f2(view.tx));
          fitView();
          setFollow(false);
          /* 长按（手指停留超过 tapMs）也要能选站，且不能误触发缩放 */
          var st2 = M.byId.huochenanzhan;
          var sp2 = { x: st2.x * view.k + view.tx, y: st2.y * view.k + view.ty };
          setTarget(null);
          closePopup();
          var kBeforeLong = view.k;
          pe('pointerdown', sp2.x, sp2.y, 41);
          setTimeout(function () {
            pe('pointerup', sp2.x, sp2.y, 41);
            setTimeout(function () {
              chk('长按（停留 > tapMs）也能选中站点', popupId === 'huochenanzhan' && Math.abs(view.k - kBeforeLong) < 1e-9,
                'popup=' + String(popupId) + ' k=' + f2(view.k));
              /* 用悬浮窗里的按钮派车 */
              $('spGo').click();
              setTimeout(function () {
                chk('悬浮窗“列车运行到该站”可派车', state.target === 'huochenanzhan',
                  'target=' + String(state.target) + ', btn=' + $('spGo').textContent);
                chk('悬浮窗按钮变为可取消', /取消/.test($('spGo').textContent), $('spGo').textContent);
                setTarget(null);
                closePopup();
                /* 布局：面板与页面都不能超出视口 */
                var pr = $('panel').getBoundingClientRect();
                chk('控制面板不超出视口边界',
                  pr.right <= window.innerWidth + 1 && pr.bottom <= window.innerHeight + 1 && pr.left >= -1 && pr.top >= -1,
                  'panel=[' + Math.round(pr.left) + ',' + Math.round(pr.top) + ',' + Math.round(pr.right) + ',' + Math.round(pr.bottom) +
                  '] viewport=' + window.innerWidth + 'x' + window.innerHeight);
                chk('页面无横向/纵向溢出',
                  document.documentElement.scrollWidth <= window.innerWidth + 1 &&
                  document.documentElement.scrollHeight <= window.innerHeight + 1,
                  'scroll=' + document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight +
                  ' viewport=' + window.innerWidth + 'x' + window.innerHeight);
                chk('折叠按钮可用（面板可收起）', (function () {
                  $('btnPanel').click();
                  var hidden = $('app').classList.contains('panel-hidden');
                  $('btnPanel').click();
                  return hidden && !$('app').classList.contains('panel-hidden');
                })());
                /* 桩测试：服务端版本更新时，必须用 location.replace + 带 _v 的地址强制重载
                   （把 fetch 与 navigateTo 换成桩，既验证行为又不真的跳转） */
                var origFetch = window.fetch, origNav = navigateTo, origVer = BUILD_VERSION, origRemote = REMOTE_VERSION;
                var got = null, boom = '';
                try {
                  resetReloadBudget();                 // 清掉“防跑飞”预算，否则桩测试会被拦住
                  BUILD_VERSION = { version: '2000-01-01.0000', commit: 'old' };   // 假装页面还是旧版
                  REMOTE_VERSION = { version: '2099-01-01.0000', commit: 'new' };   // 假装服务端已是新版
                  navigateTo = function (u) { got = u; };
                  window.fetch = function () {
                    return Promise.resolve({
                      ok: true,
                      json: function () { return Promise.resolve({ version: '2099-01-01.0000', commit: 'new' }); }
                    });
                  };
                  checkUpdate(false);
                } catch (e) { boom = '同步异常: ' + String(e && e.message || e); }
                setTimeout(function () {
                  try {
                    var ok = !!got && /_v=\d+/.test(got) && got.indexOf(location.pathname) === 0;
                    var keep = '';
                    if (location.search) {
                      var key = location.search.replace(/^\?/, '').split('&')[0].split('=')[0];
                      keep = key;
                      ok = ok && got.indexOf(key + '=') >= 0;
                    }
                    chk('服务端版本更新时：带 _v 的 cache-busting 地址 + location.replace 强制重载', ok,
                      (boom ? boom + ' ' : '') + 'navigateTo("' + String(got) + '")' +
                      (keep ? '  保留了 ' + keep + '=' : '') + '  当前 search="' + location.search + '"');
                  } catch (e2) {
                    chk('服务端版本更新时：带 _v 的 cache-busting 地址 + location.replace 强制重载', false,
                      '异常: ' + String(e2 && e2.message || e2));
                  }
                  window.fetch = origFetch;
                  navigateTo = origNav;
                  BUILD_VERSION = origVer;
                  REMOTE_VERSION = origRemote;
                  try { renderVersion(BUILD_VERSION); } catch (e3) { void e3; }
                  done();
                }, 700);
              }, 340);
            }, 40);
          }, CFG.tapMs + 120);
        }, 400);
      }, 320);
    }, 320);
  }

  function boot() {
    init();
    if (/[?&]selftest/.test(location.search)) {
      setTimeout(function () {
        try {
          var out = selfTest();
          selfTestInteraction(function (name, cond, detail) {
            out.checks.push({ name: name, pass: !!cond, detail: detail === undefined ? '' : detail });
            if (!cond) out.ok = false;
          }, function () {
            var pre = document.getElementById('selftest');
            pre.textContent = JSON.stringify(out, null, 1);
            document.title = (out.ok ? 'SELFTEST-PASS' : 'SELFTEST-FAIL') + ' ' +
              out.checks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }).join('|');
          });
        } catch (e) { document.title = 'SELFTEST-ERROR ' + e.message; }
      }, 300);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 供自动化/调试使用 */
  window.__metro = {
    state: state, ROUTES: ROUTES, CFG: CFG, M: M,
    stepTrain: stepTrain, setTarget: setTarget, reset: resetState,
    pointAt: pointAt, kmToMap: kmToMap, recomputeEta: recomputeEta,
    hitStation: hitStation, zoomAt: zoomAt, fitView: fitView, view: view,
    stationKm: stationKm, stationMapS: stationMapS, panBox: panBox, contentBox: contentBox, stage: stage,
    openPopup: openPopup, closePopup: closePopup, etaFor: etaFor, refreshPopup: refreshPopup,
    get trains() { return trains; }, get activeIdx() { return activeIdx; }, setActive: setActive,
    hitTrain: hitTrain, legEta: legEta, nextStopOf: nextStopOf, updateNextMarks: updateNextMarks,
    trainPills: pillEls, updateTrainPills: updateTrainPills,
    collapseBubbles: collapseBubbles, bubbleWraps: bubbleWraps, resetTrain: resetTrain, stepAll: function (sec) {
      var t = 0;
      while (t < sec) { trains.forEach(function (tr) { stepTrain(tr, 0.05); }); t += 0.05; }
    },
    refreshUrlFor: refreshUrlFor, checkUpdate: checkUpdate, fetchVersion: fetchVersion,
    hardReload: hardReload, resetReloadBudget: resetReloadBudget, get lastReloadUrl() { return lastReloadUrl; },
    navigateTo: function (u) { navigateTo(u); },
    get versionInfo() { return BUILD_VERSION; }, get remoteVersion() { return REMOTE_VERSION; },
    audio: audio, setSound: setSound, initAudio: initAudio, announce: announce, announceText: announceText,
    chime: chime, speak: speak, nextStopAfter: nextStopAfter, showAnnounce: showAnnounce,
    trainIndexForLine: trainIndexForLine, updateStationList: updateStationList, scrollListToActive: scrollListToActive
  };
})();
