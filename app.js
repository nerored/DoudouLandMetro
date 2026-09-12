/* =============================================================================
 * app.js - 豆豆国的地铁（成都地铁全网）：示意线路图 + 8 车厢列车运行模拟
 * 纯 vanilla JS（无依赖、无构建）。依赖 data.js 暴露的 window.METRO。
 *
 * 主要模块：
 *   1. 路径采样（Catmull-Rom 平滑曲线 -> 弧长参数化，供列车沿线路行驶）
 *   2. 底图装饰（网格 / 街区 / 道路 / 河流 / 公园）
 *   3. 线路、车站、站名标签（防重叠）
 *   4. 8 车厢列车（按弧长排布，沿切线方向贴合线路）
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
    smallPillW: 480,       // 舞台宽度小于此值时：列车贴片只留当前列车、只弹当前列车的气泡（强调圈照画）
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
  var ui = { paused: false, mult: 1, follow: false, showLines: {} };
  /* 时间流逝比例：现实 1 秒 = 游戏 TIME_BASE 秒（基础 1:2），面板倍速在此之上再乘 */
  var TIME_BASE = 2;
  function timeRatio() { return TIME_BASE * (ui.mult || 1); }

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
    var out = [];
    (M.lines || []).forEach(function (line) {
      var svc = line.services && line.services[0];
      if (svc && ROUTES[svc.key] && out.indexOf(svc.key) < 0) out.push(svc.key);
    });
    return out.length ? out : Object.keys(ROUTES);
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
    /* 交路两端各加一段折返线延长（环线则把首尾闭合，不加折返线） */
    var isLoop = !!svc.loop;
    if (isLoop && samples.length > 2) {
      var f0 = samples[0], l0 = samples[samples.length - 1];
      if (Math.hypot(f0.x - l0.x, f0.y - l0.y) < 40) samples[samples.length - 1] = { x: f0.x, y: f0.y };
    } else if (samples.length > 1) {
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
    /* 环线：把采样起点旋到「本交路首发站」处（环的首尾相接，否则首站会落在环的末端、里程不为 0） */
    if (isLoop) {
      var st0 = M.byId[(svc.stationIds || [])[0]];
      if (st0) {
        var bi = 0, bd = Infinity;
        for (i = 0; i < samples.length; i++) {
          var dd = Math.hypot(samples[i].x - st0.x, samples[i].y - st0.y);
          if (dd < bd) { bd = dd; bi = i; }
        }
        if (bi > 0) {
          samples = samples.slice(bi).concat(samples.slice(0, bi));
          cum = [0];
          for (i = 1; i < samples.length; i++) {
            cum[i] = cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
          }
        }
      }
    }
    var route = {
      key: svc.key, label: svc.label, lineKey: svc.lineKey, color: svc.color,
      loop: isLoop, ccw: false,
      samples: samples, cum: cum, length: cum[cum.length - 1],
      ids: [], mapAt: [], kmAt: [], projErr: 0
    };
    /* 环线的绕行方向：成都地铁的环线用「内环/外环」而不是「上行/下行」报方向，
       官方口径是 **内环 = 顺时针、外环 = 逆时针**（四川新闻网 2017-12-06《成都地铁7号线：首推“内/外环”新概念》）。
       坐标是 y 向下的投影（y 变大 = 往南），所以“地理逆时针”对应带符号面积为负。 */
    if (isLoop) {
      var area2 = 0;
      for (i = 1; i < samples.length; i++) {
        area2 += samples[i - 1].x * samples[i].y - samples[i].x * samples[i - 1].y;
      }
      route.ccw = area2 < 0;
    }
    (svc.stationIds || []).forEach(function (id) {
      var st = M.byId[id];
      if (!st) return;
      var r = projectOnPolyline(route, st.x, st.y);
      route.ids.push(id);
      route.mapAt.push(r.s);
      route.kmAt.push(Math.max(0, r.s - (isLoop ? 0 : CFG.stub)) / M.unitsPerKm);
      route.projErr = Math.max(route.projErr, r.d);
    });
    /* 里程必须单调递增：换乘站的坐标在别的线轨道上，投影到本线时可能落到折线“另一处”，
       否则仿真里的列车会往回跳 */
    for (var q = 1; q < route.kmAt.length; q++) {
      if (!(route.kmAt[q] > route.kmAt[q - 1])) route.kmAt[q] = route.kmAt[q - 1] + 0.005;
    }
    /* 环线的一圈里程 = 轨道全长（不是“到末站”的里程：末站到首站还有一段闭合腿） */
    route.kmLength = isLoop ? route.length / M.unitsPerKm : route.kmAt[route.kmAt.length - 1];
    route.terminus = route.ids[route.ids.length - 1];
    route.origin = route.ids[0];
    return route;
  }

  var ROUTES = {};
  (M.lines || []).forEach(function (line) {
    line.services.forEach(function (svc) {
      /* 交路的线路归属/色号：数据里可能只写在 line 上，这里补齐（两种数据形状都能用） */
      svc.lineKey = svc.lineKey || line.key;
      svc.color = svc.color || line.color;
      ROUTES[svc.key] = buildRoute(svc);
    });
  });
  var ROUTE_KEYS = Object.keys(ROUTES);
  /* 注意：JS 对象会把整数型 key 排到前面（'2','3'… 会排在 '1main' 前面），
     所以默认交路与列车顺序不能直接用 Object.keys，要按 M.lines 的顺序来。 */
  var DEFAULT_ROUTE = ROUTES['1main'] ? '1main' : ROUTE_KEYS[0];
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
    /* 环线：末站之后还有一段“闭合腿”（末站 → 首站），虚拟补上终点做插值——
       否则最后 0.7 km 会被 clamp 钉在末站，看着就是“列车停在双店路不走”。 */
    if (route.loop && a.length > 1 && km > a[a.length - 1]) {
      var aN = a[a.length - 1];
      var aE = route.kmLength + a[0];
      var t = (km - aN) / Math.max(1e-9, aE - aN);
      return m[m.length - 1] + ((m[0] + route.length) - m[m.length - 1]) * t;
    }
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

    /* 道路：OSM motorway / trunk / primary（装饰层，只求城市骨架观感）
       线路扩到全网后道路段上万条，逐段建 DOM 会撑爆渲染（一段两个 path）：
       改为**按等级合并成 3 条 path**（每级两条 = 描边 + 主色），DOM 从 1.3 万节点降到 6 个，
       视觉完全一致（同一套 fill-rule / stroke-linecap）。 */
    var roads = svg('g', { id: 'roads' }, g);
    var RW = { motorway: 7, trunk: 5.5, primary: 4 };
    (function () {
      var byCls = {};
      (M.roads || []).forEach(function (rd) {
        if (!rd.pts || rd.pts.length < 2) return;
        var d = 'M' + rd.pts.map(function (p) { return f1(p[0]) + ' ' + f1(p[1]); }).join('L');
        (byCls[rd.c] = byCls[rd.c] || []).push(d);
      });
      Object.keys(byCls).forEach(function (cls) {
        var d = byCls[cls].join('');
        var w = RW[cls] || 4.5;
        svg('path', { class: 'bg-road-casing', d: d, 'stroke-width': w + 2.6 }, roads);
        svg('path', { class: 'bg-road', d: d, 'stroke-width': w }, roads);
      });
    })();

    /* 河流（OSM waterway）：锦江/府河/南河画粗一点；同样按粗细合并成 2 条 path */
    var water = svg('g', { id: 'water' }, g);
    (function () {
      var big = [], small = [];
      (M.water && M.water.rivers ? M.water.rivers : []).forEach(function (rv) {
        if (!rv.pts || rv.pts.length < 2) return;
        var d = 'M' + rv.pts.map(function (p) { return f1(p[0]) + ' ' + f1(p[1]); }).join('L');
        (/锦江|府河|南河/.test(rv.name) ? big : small).push(d);
      });
      [[big, 22], [small, 11]].forEach(function (pair) {
        if (!pair[0].length) return;
        var p = svg('path', { class: 'bg-water', d: pair[0].join('') }, water);
        p.style.strokeWidth = pair[1] + 'px';
      });
    })();
    /* 湖泊（OSM natural=water 多边形）：也合成一条 path */
    (function () {
      var ds = [];
      (M.water && M.water.lakes ? M.water.lakes : []).forEach(function (lk) {
        if (!lk.pts || lk.pts.length < 3) return;
        ds.push('M' + lk.pts.map(function (p) { return f1(p[0]) + ' ' + f1(p[1]); }).join('L') + 'Z');
      });
      if (ds.length) svg('path', { class: 'bg-lake', d: ds.join('') }, water);
    })();

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
          if (!seen[tk] && TRACKS[tk]) { seen[tk] = 1; order.push({ k: tk, color: line.color, lineKey: line.key }); }
        });
      });
    });
    order.forEach(function (o) {
      var tr = TRACKS[o.k];
      var d = 'M' + tr.samples.map(function (p) { return f1(p.x) + ' ' + f1(p.y); }).join('L');
      var bed = svg('path', { class: 'rail-bed', d: d, 'stroke-width': 15 }, g);
      var path = svg('path', { class: 'rail', d: d, 'stroke-width': 10.5 }, g);
      path.style.stroke = o.color;          // CSS 里的 .rail 用 var(--line)，这里按线路覆盖
      regLine(o.lineKey, bed);
      regLine(o.lineKey, path);
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
      (st.lines || []).forEach(function (k) { regLine(k, dotG); });
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
      (st.lines || []).forEach(function (k) { regLine(k, L.g); });
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
    /* 只排布可视区域内的站名（366 站全量排布会卡） */
    var pad = 260 / Math.max(view.k, 0.01);
    var bx0 = (-view.tx) / view.k - pad, by0 = (-view.ty) / view.k - pad;
    var bx1 = (stage.w - view.tx) / view.k + pad, by1 = (stage.h - view.ty) / view.k + pad;
    labelEls.forEach(function (L) {
      var vis = L.vis && L.st.x >= bx0 && L.st.x <= bx1 && L.st.y >= by0 && L.st.y <= by1;
      L.inView = vis;
      L.g.classList.toggle('offscreen', !vis);
    });
    labelBoxes = [];
    var vis = labelEls.filter(function (L) { return L.vis; });
    /* 小视口下的“标签预算”：屏幕小就少显示几个，但优先保住当前控制列车的当前站/下一站/目标站，
       其次换乘站、端点站——这样绝对重叠量真的下降（而不是把标准放寛）。 */
    function prio(L) {
      var st = L.st, p = 0;
      if (st.id === state.curId) p += 1000;
      var nxId = ROUTES[state.routeKey].ids[state.nextIdx];
      if (st.id === nxId) p += 900;
      if (state.target && st.id === state.target) p += 800;
      if (st.term) p += 200;
      if (st.lines && st.lines.length > 1) p += 300;
      if (st.tr && st.tr.length) p += 100;
      return p;
    }
    var budget = (stage.w * stage.h) < 900000 ? clamp(Math.round((stage.w * stage.h) / 45000), 8, 22) : 999;
    if (budget < 999) {
      vis = vis.slice().sort(function (a, b) {
        var pa = prio(a), pb = prio(b);
        if (pa !== pb) return pb - pa;
        if (a.key !== b.key) return a.key ? -1 : 1;
        return a.st.y - b.st.y;
      }).slice(0, budget);
      var inBudget = {};
      vis.forEach(function (L) { inBudget[L.st.id] = 1; });
      labelEls.forEach(function (L) {
        if (L.vis && !inBudget[L.st.id]) L.g.classList.add('offscreen');
      });
    }
    var order = vis.slice().sort(function (a, b) {
      if (budget < 999) {
        var pa = prio(a), pb = prio(b);
        if (pa !== pb) return pb - pa;
      }
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
      L.__rect = rect2;
      /* 实在放不下（与已有标签重叠过多）：宁可不显示，也不要盖成一团 */
      var area = Math.max(1, (rect2.x1 - rect2.x0) * (rect2.y1 - rect2.y0));
      if (bestPen / area > 0.35) {
        L.g.classList.add('offscreen');
        return;
      }
      labelBoxes.push(rect2);
    });
    /* 后处理：后面的标签可能盖到前面的——最后统一算一次，盖得太多的直接隐藏 */
    var vis2 = labelEls.filter(function (L) { return L.vis && L.inView && !L.g.classList.contains('offscreen'); });
    for (var a = 0; a < vis2.length; a++) {
      var ra = vis2[a].__rect;
      if (!ra) continue;
      var areaA = Math.max(1, (ra.x1 - ra.x0) * (ra.y1 - ra.y0));
      var ov = 0;
      for (var b2 = 0; b2 < vis2.length; b2++) {
        if (a === b2 || !vis2[b2].__rect) continue;
        ov += overlapArea(ra, vis2[b2].__rect);
      }
      if (ov / areaA > 0.3) vis2[a].g.classList.add('offscreen');
    }
    /* 后处理 2（关键）：按“与单个标签的最大重叠 ÷ 自身面积”剔除违规者
       —— 与自检同一口径（标准 25%），并且把被剔除的**从 labelBoxes 里移除**，
       否则它们仍然会被统计（之前的 bug：只藏不删，所以 1400×900 怎么都过不了）。 */
    for (var pass = 0; pass < 4; pass++) {
      var removed = 0;
      for (var i2 = labelBoxes.length - 1; i2 >= 0; i2--) {
        var bi = labelBoxes[i2];
        var ai = Math.max(1, bi.w * bi.h);
        var mx = 0;
        for (var j2 = 0; j2 < labelBoxes.length; j2++) {
          if (j2 === i2) continue;
          mx = Math.max(mx, overlapArea(bi, labelBoxes[j2]) / ai);
        }
        if (mx > 0.20) {
          for (var q2 = 0; q2 < labelEls.length; q2++) {
            if (labelEls[q2].__rect === bi) { labelEls[q2].g.classList.add('offscreen'); break; }
          }
          labelBoxes.splice(i2, 1);
          removed++;
        }
      }
      if (!removed) break;
    }
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
    /* 站名标签屏幕恒定：字号 15 地图单位 × labelScale × view.k = 15px 屏幕。
       以前把 labelScale 封顶在 2.0，低缩放下标签会缩成 3px 的噪声（看得见但读不着）；
       现在不封顶——标签一多，就交给小视口预算 + 防重叠去淘汰，数量可控、字号不糊。 */
    labelScale = Math.max(0.34, 1 / view.k);
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

  /* 每列车一个 group（8 节车厢）；色带颜色由 group 上的 --line 决定 */
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
      regLine(ROUTES[tr.routeKey].lineKey, g);
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
      /* 视口裁剪：不在可视区域内的列车不重绘也不显示（线路多/列车多时很重要） */
      var hp0 = pointAt(route, sHead);
      var scx = hp0.x * view.k + view.tx, scy = hp0.y * view.k + view.ty;
      var vis = scx > -220 && scx < stage.w + 220 && scy > -220 && scy < stage.h + 220;
      grp.g.classList.toggle('offscreen', !vis);
      if (!vis) return;
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

  /* 点到哪列车（车头/车厢中点 30px 内）；命中距离记在 hitTrainDist，供“站优先还是车优先”比较 */
  var hitTrainDist = Infinity;
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
    hitTrainDist = best < 0 ? Infinity : bestD;
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
    if (r.loop) {                     // 环线：首尾相接，末站的下一站就是首站
      if (j < 0) j = r.ids.length - 1;
      if (j >= r.ids.length) j = 0;
      return r.ids[j];
    }
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
    /* 小舞台（手机）上气泡只给当前控制列车：17 列车的话站名上方会被贴满。
       强调圈（下一站在哪）看颜色就能认，继续全画，不牺牲“每列车都有下一站标记”。 */
    var onlyActiveBubbles = stage.w < CFG.smallPillW;
    trains.forEach(function (tr, ti) {
      var mk = markEls[ti];
      if (!mk) return;
      if (!lineVisible(ROUTES[tr.routeKey].lineKey)) {       // 该线被图例筛掉了：不画强调圈
        mk.halo.style.display = mk.ring.style.display = 'none';
        return;
      }
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
      if (onlyActiveBubbles && ti !== activeIdx) return;     // 不弹气泡，但强调圈已画好
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

  /* ==================================================== 线路筛选（图例色块点击）
     线路多了以后图例不能一行一条；改成色块网格，点一下只看该线（可多选），再点取消。
     把每条线的轨道/车站/标签/列车元素登记下来，过滤时整组隐藏。 */
  var lineElems = {};
  function regLine(key, el) {
    if (!key || !el) return;
    (lineElems[key] = lineElems[key] || []).push(el);
  }
  function lineVisible(key) {
    var keys = Object.keys(ui.showLines || {});
    if (!keys.length) return true;
    return !!ui.showLines[key];
  }
  function applyLineFilter() {
    Object.keys(lineElems).forEach(function (k) {
      var on = lineVisible(k);
      lineElems[k].forEach(function (el) { el.classList.toggle('line-off', !on); });
    });
    var solo = Object.keys(ui.showLines || {}).length > 0;
    $('legend').classList.toggle('filtering', solo);
    /* 线路色块的选中态（线路 tab 里的 17 个 chip） */
    var box = $('lgLines');
    if (box) {
      Array.prototype.forEach.call(box.children, function (b) {
        var k = b.getAttribute('data-line');
        var sel = solo && !!ui.showLines[k];
        b.classList.toggle('on', sel);
        b.classList.toggle('off', solo && !ui.showLines[k]);
        b.setAttribute('aria-pressed', sel ? 'true' : 'false');
        b.style.color = sel ? (b.querySelector('i') ? b.querySelector('i').style.background : '') : '';
      });
    }
    updateNextMarks();          /* 被隐藏的线路不再弹到站气泡 */
    positionBubbles();
  }
  function buildLegend() {
    var box = $('lgLines');
    if (!box) return;
    box.innerHTML = '';
    LINES.forEach(function (l) {
      var line = M.lines.filter(function (x) { return x.key === l.key; })[0];
      var n = line && line.services[0] ? line.services[0].stationIds.length : 0;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lg-chip';
      b.setAttribute('data-line', l.key);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<i style="background:' + l.color + '"></i>' + l.short + '<em>' + n + '</em>';
      b.title = l.name + '（点一下只看该线，可多选）';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        ui.showLines = ui.showLines || {};
        if (ui.showLines[l.key]) delete ui.showLines[l.key];
        else ui.showLines[l.key] = true;
        applyLineFilter();
        toast(Object.keys(ui.showLines).length
          ? '只看：' + Object.keys(ui.showLines).map(lineShort).join('、')
          : '已显示全部线路');
      });
      box.appendChild(b);
    });
  }

  /* 地图上的 HTML 覆盖件（HUD/按钮/图例/比例尺/版本徽标/站点悬浮窗）占据的区域：
     到站气泡与列车标签必须避让它们，宁可藏起来也不覆盖控制面板 */
  function reservedBoxes() {
    var out = [], sb = $('stage').getBoundingClientRect();
    ['hud', 'btnHardRefresh', 'btnPanel', 'compass', 'legend', 'scalebar', 'stpop'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      var hidden = el.hidden || (el.classList && el.classList.contains('hide'));
      if (hidden) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      out.push({ x: r.left - sb.left - 6, y: r.top - sb.top - 6, w: r.width + 12, h: r.height + 12 });
    });
    return out;
  }
  function hitsAny(boxes, x, y, w, h) {
    for (var i = 0; i < boxes.length; i++) {
      var q = boxes[i];
      if (x < q.x + q.w && x + w > q.x && y < q.y + q.h && y + h > q.y) return true;
    }
    return false;
  }
  /* 依次尝试几个候选位置；全都不行就隐藏（不覆盖控制面板） */
  function placeAvoiding(el, cx, cy, w, h, boxes, placed) {
    var maxY = Math.max(6, stage.h - h - 6), maxX = Math.max(6, stage.w - w - 6);
    var cands = [
      [cx - w / 2, cy - h - 16],      // 站/车上方
      [cx - w / 2, cy + 18],          // 下方
      [cx + 20, cy - h / 2],          // 右侧
      [cx - w - 20, cy - h / 2],      // 左侧
      [cx - w / 2, cy - h - 46],
      [cx - w / 2, cy + 48]
    ];
    for (var i = 0; i < cands.length; i++) {
      var x = clamp(cands[i][0], 6, maxX), y = clamp(cands[i][1], 6, maxY);
      if (hitsAny(boxes, x, y, w, h)) continue;
      var clash = false;
      for (var k = 0; k < placed.length && !clash; k++) {
        var q = placed[k];
        if (x < q.x + q.w + 4 && x + w + 4 > q.x && y < q.y + q.h + 4 && y + h + 4 > q.y) clash = true;
      }
      if (clash) continue;
      el.style.left = Math.round(x) + 'px';
      el.style.top = Math.round(y) + 'px';
      el.style.visibility = '';
      placed.push({ x: x, y: y, w: w, h: h });
      return true;
    }
    el.style.visibility = 'hidden';   // 实在没地方：藏起来，不动控制面板
    return false;
  }

  /* 气泡与列车标签定位：都避开覆盖件与彼此 */
  function positionBubbles() {
    var res = reservedBoxes();
    var placed = [];
    /* 列车标签优先（它是“哪列车”的关键标识）；小屏幕上只留当前控制列车那一个，
       其余先藏起来——17 张贴片会把手机地图盖满（点面板里的“切换列车”仍可换车）。 */
    var onlyActivePill = stage.w < CFG.smallPillW;
    trains.forEach(function (tr, ti) {
      var b = pillEls[ti];
      if (!b) return;
      if (onlyActivePill && ti !== activeIdx) { b.style.visibility = 'hidden'; return; }
      var route = ROUTES[tr.routeKey];
      var hp = pointAt(route, kmToMap(route, tr.posKm));
      placeAvoiding(b, hp.x * view.k + view.tx, hp.y * view.k + view.ty,
        b.offsetWidth || 92, b.offsetHeight || 24, res, placed);
    });
    Object.keys(bubbleWraps).forEach(function (sid) {
      var st = M.byId[sid], wrap = bubbleWraps[sid];
      if (!st || !wrap) return;
      placeAvoiding(wrap, st.x * view.k + view.tx, st.y * view.k + view.ty,
        wrap.offsetWidth || 132, wrap.offsetHeight || 30, res, placed);
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
  /* 线路短名：1~30 号线就是「N 号线」，S3 是「市域铁路 S3 资阳线」（不能拿 key 硬拼“S3号线”） */
  function lineShort(key) {
    return LINE_BY_KEY[key] ? LINE_BY_KEY[key].short : key;
  }

  /* 方向文案：普通线路“上行/下行”，环线用“内环/外环”
     （内环 = 顺时针、外环 = 逆时针；ccw 是该交路“正向”在地理上的绕行方向） */
  function dirName(route, dir) {
    if (!route.loop) return dir > 0 ? '下行' : '上行';
    var cw = dir > 0 ? !route.ccw : route.ccw;
    return cw ? '内环' : '外环';
  }
  /* 环线没有终点可“往”，改成报“下一站”；普通线路仍报终点 */
  function boundText(st) {
    var route = ROUTES[st.routeKey];
    if (route.loop) {
      /* 用 nextStopOf 而不是 ids[nextIdx]：停站时 nextIdx 还指着本车所在的站 */
      var nx = nextStopOf(st);
      return nx && M.byId[nx] ? '下一站' + M.byId[nx].zh : '环行';
    }
    return '往' + M.byId[terminusId()].zh;
  }

  /* 切换交路（不重置列车位置：旧位置仍在新交路上就保位置，否则退到分叉站） */
  function switchService(key, quiet) {
    if (!ROUTES[key] || key === state.routeKey) { syncRouteSelect(); return false; }
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
    syncRouteSelect();
    if (!quiet) {
      toast('交路切换为 ' + r.label + '（' + lineOf(key).short + '）' +
        (moved ? '，列车退至' + M.byId[state.curId].zh + '站' : ''));
    }
    recomputeEta();
    return true;
  }

  /* 交路下拉始终反映“当前控制列车所属线路 + 交路”（列车卡片/地图点车/点站切线路都要同步） */
  function syncRouteSelect() {
    var sel = $('selRoute');
    if (sel && state && state.routeKey && sel.value !== state.routeKey) sel.value = state.routeKey;
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

    /* 环线：一直朝前走，到末站绕回起点（不折返） */
    if (route.loop) {
      var wantLoop = st.target && serviceForStation(st.target, st.routeKey) === st.routeKey ? route.ids.indexOf(st.target) : -1;
      var nextI = i + 1;
      if (nextI >= route.ids.length) nextI = 0;
      st.nextIdx = nextI;
      st.phase = 'run';
      st.v = 0;
      void wantLoop;
      return;
    }

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
      if (!st.aOpened) { st.aOpened = true; announce(st, 'open'); }
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
    /* 环线绕回起点的那一段（末站 → 首站）是真实的闭合腿，必须把终点算成跑完一圈的里程，
       否则 tKm 落到 0（< 当前里程）会被判成“已到达”，表现是列车从末站瞬移回首站。
       注意单位：st.posKm 是 km，route.kmLength 也是 km（不能用 route.length，那是地图单位）。 */
    var tKm = (route.loop && st.dir > 0 && st.nextIdx === 0 && st.posKm > route.kmLength / 2)
      ? route.kmLength : route.kmAt[st.nextIdx];
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
    /* 可见区域 = 舞台减去抽屉遮住的部分，宁可让线路落在可见带里，
       否则竖屏上「全网」会正好被抽屉压掉一半 */
    var visH = Math.max(120, stage.h - (sheet.visH || 0));
    var k = Math.min(stage.w / (c.x1 - c.x0), visH / (c.y1 - c.y0));
    /* 下限放宽到 0.04：手机上「全网适配」需要 k≈0.09，以前卡在 0.12 会把远端线路切出屏幕 */
    view.k = clamp(k, 0.04, 20);
    view.tx = stage.w / 2 - (c.x0 + c.x1) / 2 * view.k;
    view.ty = visH / 2 - (c.y0 + c.y1) / 2 * view.k;
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

  /* 轻点：站点优先于列车——列车每站要停 10 s，停站时车身就盖在站台上，
     若让列车优先，那 10 秒里点站会“没反应”（用户报过“站点点不动”）。
     只有列车明显更近（距站点圆心比距车厢中心还近）时才判成点车。 */
  function handleTap(pos) {
    lastTapHandled = performance.now();
    var ti = hitTrain(pos), td = hitTrainDist;
    var hit = hitStation(pos), sd = hitStationD;
    if (hit && (ti < 0 || sd <= td)) { openPopup(hit, pos); return; }
    if (ti >= 0) {
      if (ti !== activeIdx) { setActive(ti); activateSideEffects(); }
      else { toast('当前已是这列车：' + LINE_BY_KEY[ROUTES[state.routeKey].lineKey].short); }
      return;
    }
    collapseBubbles();
    closePopup();
  }

  var hitStationD = Infinity;      // 最近一次 hitStation 的命中距离（px）
  function hitStation(p) {
    var best = null, bestD = CFG.tapRadius;
    M.stations.forEach(function (st) {
      var sx = st.x * view.k + view.tx, sy = st.y * view.k + view.ty;
      var d = Math.hypot(sx - p.x, sy - p.y);
      if (d < bestD) { bestD = d; best = st.id; }
    });
    hitStationD = best ? bestD : Infinity;
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

  /* ==================================================== 控制区：tab + 抽屉
     设计契约见 DESIGN.md §4「Shell」：宽屏横屏是右侧 dock，手机/竖屏是底部抽屉（同一套 DOM），
     #panelBody 是**唯一**的滚动归属；抽屉三档 peek/half/full 只动 transform（--sheet-t）。 */
  var TABS = ['lines', 'train', 'nav', 'stations'];
  var activeTab = 'train';
  var MQ_DOCK = (window.matchMedia ? window.matchMedia('(min-width: 760px) and (min-aspect-ratio: 1/1)') : null);
  var sheet = { snap: 'half', force: null, visH: 0 };   // force：自检里强制走抽屉分支；visH：抽屉当前遮住多少

  function setIcon(btn, iconId) {
    var u = btn && btn.querySelector('use');
    if (u) u.setAttribute('href', '#' + iconId);
  }
  function setLabel(btn, txt) {
    if (!btn) return;
    var l = btn.querySelector('.lbl');
    if (l) l.textContent = txt; else btn.textContent = txt;
  }
  function sheetMode() {
    if (sheet.force) return sheet.force === 'sheet';
    return MQ_DOCK ? !MQ_DOCK.matches : true;
  }

  /* ---- tab：一次只显示一个 pane，aria-selected 唯一 ---- */
  function setTab(name) {
    if (TABS.indexOf(name) < 0) name = 'train';
    activeTab = name;
    TABS.forEach(function (t) {
      var btn = $('tabBtn-' + t), pane = $('tab-' + t);
      var on = (t === name);
      if (btn) { btn.setAttribute('aria-selected', on ? 'true' : 'false'); btn.tabIndex = on ? 0 : -1; }
      if (pane) pane.hidden = !on;
    });
    var body = $('panelBody');
    if (body) body.scrollTop = 0;
  }
  function initTabs() {
    var bar = $('tabs');
    if (!bar) return;
    TABS.forEach(function (t) {
      var btn = $('tabBtn-' + t);
      if (btn) btn.addEventListener('click', function () { setTab(t); });
    });
    bar.addEventListener('keydown', function (e) {
      var i = TABS.indexOf(activeTab), n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TABS.length - 1;
      if (n < 0) return;
      e.preventDefault();
      setTab(TABS[n]);
      var b = $('tabBtn-' + TABS[n]);
      if (b) b.focus();
    });
    setTab(activeTab);
  }

  /* ---- 抽屉：peek（把手 + tab + 状态胶囊）/ half / full ----
     几何：面板底边钉在视口底部，用 translateY **向下**推（panelH - 可见高）——
     推得越多，露出的越是面板**顶部**的把手与 tab（这才是收起状态该看到的东西）。 */
  function sheetGeom() {
    var panel = $('panel'), h = $('sheetHandle'), tb = $('tabs');
    var panelH = panel ? panel.getBoundingClientRect().height : 0;
    var peek = (h ? h.offsetHeight : 56) + (tb ? tb.offsetHeight : 52);
    var vh = window.innerHeight || 800;
    return { panelH: panelH, peek: peek, half: Math.min(vh * 0.52, 460), full: Math.min(vh * 0.86, 760) };
  }
  function applySnap(name) {
    if (['peek', 'half', 'full'].indexOf(name) < 0) name = 'half';
    var app = $('app'), h = $('sheetHandle');
    if (!sheetMode()) {
      app.setAttribute('data-snap', 'dock');
      app.style.setProperty('--sheet-h', '0px');
      app.style.removeProperty('--sheet-t');
      sheet.visH = 0;
      sheet.snap = name;
      if (h) h.setAttribute('aria-expanded', 'true');
      layoutLabels(); positionBubbles();
      return;
    }
    var g = sheetGeom();
    var vis = Math.max(g.peek, Math.min(g.panelH, g[name] || g.half));
    app.setAttribute('data-snap', name);
    app.style.setProperty('--sheet-t', Math.round(g.panelH - vis) + 'px');
    app.style.setProperty('--sheet-h', Math.round(vis) + 'px');
    if (h) h.setAttribute('aria-expanded', name === 'full' ? 'true' : 'false');
    sheet.visH = vis;
    sheet.snap = name;
    if (view.fitted) fitView();          // 抽屉高度变了，全网适配跟着重新居中
    layoutLabels();
    positionBubbles();
  }
  function cycleSnap() {
    applySnap(sheet.snap === 'peek' ? 'half' : (sheet.snap === 'half' ? 'full' : 'peek'));
  }
  function initSheet() {
    var h = $('sheetHandle');
    if (!h) return;
    var drag = null;
    h.addEventListener('pointerdown', function (e) {
      if (!sheetMode()) return;
      var g = sheetGeom();
      var t0 = parseFloat(getComputedStyle($('app')).getPropertyValue('--sheet-t')) || 0;
      drag = { id: e.pointerId, y0: e.clientY, t0: t0, panelH: g.panelH, peek: g.peek, moved: 0 };
      sheet.dragging = true;
      h.setPointerCapture(e.pointerId);
      $('panel').classList.add('dragging');
    });
    h.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y0;
      drag.moved = Math.max(drag.moved, Math.abs(dy));
      var t = Math.max(0, Math.min(drag.panelH - drag.peek, drag.t0 + dy));
      $('app').style.setProperty('--sheet-t', Math.round(t) + 'px');
      $('app').style.setProperty('--sheet-h', Math.round(drag.panelH - t) + 'px');
    });
    function end() {
      if (!drag) return;
      var panel = $('panel'), g = sheetGeom();
      panel.classList.remove('dragging');
      sheet.dragging = false;
      var t = parseFloat($('app').style.getPropertyValue('--sheet-t')) || 0;
      var vis = g.panelH - t;
      var moved = drag.moved;
      drag = null;
      if (moved < 6) { cycleSnap(); return; }        // 没拖动 = 点一下，循环三档
      var cands = [['peek', g.peek], ['half', g.half], ['full', g.full]];
      var best = cands[0], bd = Infinity;
      cands.forEach(function (c) {
        var d = Math.abs(vis - Math.min(g.panelH, c[1]));
        if (d < bd) { bd = d; best = c; }
      });
      applySnap(best[0]);
    }
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('click', function (e) { if (e.detail === 0) cycleSnap(); });  // 键盘 Enter
  }

  /* ---- 站点搜索 ---- */
  function initStationSearch() {
    var inp = $('stSearch'), clr = $('stSearchClear');
    if (!inp) return;
    inp.addEventListener('input', function () {
      if (clr) clr.hidden = !inp.value;
      renderStationList();
    });
    if (clr) clr.addEventListener('click', function () {
      inp.value = ''; clr.hidden = true; renderStationList(); inp.focus();
    });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; clr.hidden = true; renderStationList(); } });
  }

  /* 图例折叠：默认只留符号一行（展开看版权/底图说明） */
  function initLegendFold() {
    var btn = $('lgFold'), meta = $('lgMeta');
    if (!btn || !meta) return;
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      meta.hidden = open;
    });
  }

  /* 线路 tab 的统计 + tab 上的计数 */
  function buildStatCounts() {
    var nSt = M.stations.length;
    var nLines = (M.lines || []).length;
    var nTr = M.stations.filter(function (s) { return s.lines && s.lines.length > 1; }).length;
    setText('statLines', nLines);
    setText('statServices', ROUTE_KEYS.length);
    setText('statStations', nSt);
    setText('statTransfer', nTr);
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
    var line = lineOf(state.routeKey);
    var curName = state.curId ? M.byId[state.curId].zh : '—';
    var nx = nextStopOf(state);
    var nxName = state.phase === 'reverse' ? '折返换向' : (nx ? M.byId[nx].zh : '—');
    var spd = state.v.toFixed(0) + ' km/h';
    var tgt = state.target ? M.byId[state.target].zh : '';

    setText('hudDir', boundText(state) + ' · ' + dirName(route, state.dir) + ' · ' + line.short);
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
    /* 状态胶囊（HUD 折叠后仍可见）+ 抽屉把手里的同一份状态 */
    setText('hudCur', curName);
    setText('hudNext', nxName);
    setText('hudSpeed', spd);
    setText('hudCur2', curName + ' 站');
    setText('sheetCur', curName);
    setText('sheetNext', nxName);
    setText('sheetSt', spd);
    setText('hudTarget', tgt ? tgt + ' 站' : '—');
    setText('hudOdo', state.odometer.toFixed(2) + ' km');
    setText('hudEta', state.eta != null ? fmtDur(state.eta) : '—');
    setText('tgName', tgt ? tgt + ' 站' : '未设置');
    setText('tgName2', tgt ? tgt + ' 站' : '未设置');
    setText('tgEta', state.eta != null ? fmtDur(state.eta) + '（实时 ' + fmtDur(state.eta / timeRatio()) + '）' : '—');
    setText('tgEta2', state.eta != null ? fmtDur(state.eta) : '—');
    setText('tgStops', state.etaStops ? state.etaStops + ' 站' : '—');
    setText('tgStops2', state.etaStops ? state.etaStops + ' 站' : '—');
    /* 列车 tab 的当前列车卡 */
    setText('curLine', line.short);
    setText('curNow', curName);
    setText('curNext', nxName);
    setText('curPhase', phaseLabel());
    setText('curSpeed', spd);
    setText('curOdo', state.odometer.toFixed(2) + ' km');
    /* 徽标用线路自己的颜色（线路色只表示线路） */
    if (hudCache.__badge !== line.color) {
      hudCache.__badge = line.color;
      ['hudLineBadge', 'sheetBadge', 'curBadge'].forEach(function (id) {
        var el = $(id);
        if (el) { el.style.background = line.color; el.textContent = line.short.replace('号线', '').replace('市域铁路 ', ''); }
      });
    }
  }

  var toastT = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* 站点列表：按线路/交路分组的折叠块 + 搜索（366 站，搜索是必需的） */
  var groupEls = [];
  var lastScrolledKey = null;
  function stationRow(id, noText) {
    var st = M.byId[id];
    if (!st) return null;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-btn';
    b.setAttribute('data-st', id);
    var no = document.createElement('span');
    no.className = 'no';
    no.textContent = noText;
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = st.zh;
    b.appendChild(no);
    b.appendChild(nm);
    if (st.en) {
      var en = document.createElement('span');
      en.className = 'en';
      en.textContent = st.en;
      b.appendChild(en);
    }
    if (st.lines && st.lines.length > 1) {
      var t0 = document.createElement('span'); t0.className = 'tag tr';
      t0.textContent = '换乘'; b.appendChild(t0);
    }
    if (st.status) { var t3 = document.createElement('span'); t3.className = 'tag'; t3.textContent = st.status; b.appendChild(t3); }
    b.addEventListener('click', function () { setTarget(id); updateStationList(); });
    return b;
  }

  function buildStationList() {
    var box = $('stlist');
    box.innerHTML = '';
    groupEls = [];
    (M.lines || []).forEach(function (line) {
      line.services.forEach(function (svc, si) {
        var r = ROUTES[svc.key];
        if (!r) return;
        var ids = r.ids;
        var from = 0;
        if (si > 0 && line.services.length > 1) {
          var a = ROUTES[line.services[0].key].ids, n = 0;
          while (n < a.length && n < ids.length && a[n] === ids[n]) n++;
          from = Math.max(0, n - 1);
        }
        var wrap = document.createElement('div');
        wrap.className = 'stgrp';
        var head = document.createElement('button');
        head.type = 'button';
        head.className = 'grp';
        head.setAttribute('data-svc', svc.key);
        head.textContent = line.short + (line.services.length > 1 ? (si === 0 ? ' 主线' : ' 支线') : '') +
          '（' + ids.length + ' 站）';
        var body = document.createElement('div');
        body.className = 'stgrp-body';
        head.addEventListener('click', function () {
          wrap.classList.toggle('open');
          layoutLabels();
        });
        wrap.appendChild(head);
        wrap.appendChild(body);
        box.appendChild(wrap);
        groupEls.push({ line: line.key, svc: svc.key, wrap: wrap, body: body });
        ids.slice(from).forEach(function (id, k) {
          var seq = from + k;
          var noText = (si > 0 && line.services.length > 1)
            ? ('0' + line.key + '|Y' + (seq - from + 1))
            : (line.short.replace('号线', '') + '|' + String(seq + 1).padStart(2, '0'));
          var row = stationRow(id, noText);
          if (row) body.appendChild(row);
        });
      });
    });
    $('stCount').textContent = '共 ' + M.stations.length + ' 站 · ' + (M.lines || []).length + ' 条线路';
    openGroupForLine(ROUTES[state.routeKey].lineKey);
    updateStationList();
  }

  /* 搜索：命中就平铺成结果列表（带线路短名），清空后恢复分组浏览 */
  function renderStationList() {
    var box = $('stlist'), inp = $('stSearch'), clr = $('stSearchClear');
    if (!box) return;
    var q = (inp && inp.value ? inp.value : '').trim().toLowerCase();
    if (clr) clr.hidden = !q;
    if (!q) { buildStationList(); return; }
    var hits = [];
    M.stations.forEach(function (s) {
      if (s.zh.toLowerCase().indexOf(q) >= 0 || (s.en || '').toLowerCase().indexOf(q) >= 0) hits.push(s);
    });
    box.innerHTML = '';
    if (!hits.length) {
      var e = document.createElement('div');
      e.className = 'st-empty';
      e.textContent = '没有匹配「' + q + '」的站点';
      box.appendChild(e);
    } else {
      hits.slice(0, 60).forEach(function (s) {
        var lk = (s.lines && s.lines[0]) || '1';
        var l = LINE_BY_KEY[lk];
        var row = stationRow(s.id, l ? l.short.replace('号线', '').replace('市域铁路 ', '') : lk);
        if (row) box.appendChild(row);
      });
    }
    setText('stCount', '共 ' + M.stations.length + ' 站 · 匹配 ' + hits.length + ' 站');
    updateStationList();
  }

  function openGroupForLine(lineKey) {
    groupEls.forEach(function (g) { g.wrap.classList.toggle('open', g.line === lineKey); });
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

  /* 站点列表跟随当前列车：把当前站滚进面板可视区。
     注意：绝不能用 scrollIntoView——它会把所有可滚祖先（包括 document）一起滚，
     固定外壳一旦被滚就会“整页错位”（实测：抽屉全开时页面被滚走 145px，标签/面板全对不上）。 */
  function scrollListToActive() {
    var body = $('panelBody'), box = $('stlist');
    if (!body || !box) return;
    var key = activeIdx + '|' + state.curId;
    if (key === lastScrolledKey) return;
    lastScrolledKey = key;
    var b = box.querySelector('[data-st="' + state.curId + '"]');
    if (!b) return;
    var br = b.getBoundingClientRect(), pr = body.getBoundingClientRect();
    if (br.top < pr.top + 6) body.scrollTop -= (pr.top + 6 - br.top);
    else if (br.bottom > pr.bottom - 6) body.scrollTop += (br.bottom - pr.bottom + 6);
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
    var t = $('verText');
    if (t) t.innerHTML = main + (extra ? ' · ' + extra : '');
    var row = $('verRow');
    if (row) row.className = 'lg-item lg-ver' + (cls ? ' ' + cls : '');
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
    reloadFresh('正在强制刷新…', nav);
  }

  function bindVersionUI() {
    var btn = $('btnRefresh'), row = $('verRow');
    function onTap(e) {
      e.preventDefault();
      e.stopPropagation();
      if (forceNextRefresh) { forceNextRefresh = false; checkUpdate(true); return; }
      checkUpdate(false);
    }
    if (btn) btn.addEventListener('click', onTap);
    if (row) row.addEventListener('click', onTap);        // 图例里的版本行也可点
    var hard = $('btnHardRefresh');
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
    var cnt = $('trainCount');
    if (cnt) cnt.textContent = '共 ' + trains.length + ' 列（每线 1 列，全部自动运行）';
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
    on: false,             // 默认关闭；用户点顶部中间的「🔇 声音关闭」开启（手势内解锁）
    vol: 0.6, announcements: 0, ttsOK: false, ttsSilent: false, ttsError: null, pendingAt: 0
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

  /* 自己的语音队列（不用 speechSynthesis.speaking，iOS 上它会卡在 true 导致后续全部不发声）
     要点：① 一条一条说，上一条 onend/onerror/看门狗 之后再放下一条；
           ② 队列最多积压 3 条，超了丢最旧的（高倍速下不会越积越多）；
           ③ rate 取 clamp(max(1,倍速), 1, 2) —— iOS 对 >2 的语速会截断，宁可用队列排队。 */
  var speechQ = [], speechBusy = false, speechWatch = null, speechSeq = 0;

  function speak(text) {
    if (!audio.on || !text || !('speechSynthesis' in window)) return;
    if (speechQ.length >= 3) speechQ.shift();
    speechQ.push({ text: text, rate: clamp(0.95 * (ui.mult || 1), 0.9, 2) });   // 入队时快照语速
    pumpSpeech();
  }

  function pumpSpeech() {
    if (speechBusy || !speechQ.length) return;
    if (!('speechSynthesis' in window)) { speechQ = []; return; }
    var item = speechQ.shift();
    var text = item.text;
    var ss = window.speechSynthesis;
    var u;
    try { u = new SpeechSynthesisUtterance(text); } catch (e) { void e; speechQ = []; return; }
    u.lang = 'zh-CN';
    /* 语音语速：基础 0.95（略慢一点更清楚），随面板倍速加快，封顶 2（iOS 对 >2 会截断） */
    u.rate = clamp(0.95 * (ui.mult || 1), 0.9, 2);
    u.pitch = 1.0;
    var v = zhVoice();
    if (v) u.voice = v;
    speechBusy = true;
    var myId = ++speechSeq;
    function done(kind) {
      if (!speechBusy || myId !== speechSeq) return;      // 已经换成新的一句了，不插手
      speechBusy = false;
      if (speechWatch) { clearTimeout(speechWatch); speechWatch = null; }
      if (kind === 'end') { audio.ttsOK = true; audio.ttsSilent = false; }
      if (kind === 'err') audio.ttsError = 'error';
      updateTtsHint();
      setTimeout(pumpSpeech, 180);            // 隔久一点，避免两条粘在一起（iOS 上尤其明显）
    }
    u.onstart = function () { audio.ttsOK = true; audio.ttsSilent = false; updateTtsHint(); };
    u.onend = function () { done('end'); };
    u.onerror = function () { done('err'); };
    /* 看门狗：iOS 上 onend 有时不触发，按预估时长兜底放行队列。
       必须带 myId 令牌：否则看门狗会在“下一条已经在说”时把 busy 清掉 → 两条叠读 → 听不清。 */
    var est = Math.min(15000, 240 * text.length / (u.rate || 1) + 3000);
    if (speechWatch) clearTimeout(speechWatch);
    speechWatch = setTimeout(function () {
      if (myId !== speechSeq) return;
      speechBusy = false;
      setTimeout(pumpSpeech, 180);
    }, est);
    audio.announcements++;
    try { ss.speak(u); } catch (e2) { speechBusy = false; speechQ = []; }
  }

  /* 第一次触摸页面时初始化/解锁音频（浏览器要求用户手势；iOS 上 TTS 也需在手势里首次调用）。
     声音默认关闭：这里只做初始化与解锁，不主动发声；等用户点顶部中间的「声音」按钮才开。 */
  var audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    var ctx = initAudio();
    if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
    if (audio.on) {
      bgmEnabled(true);
      speak('语音报站已开启');
    }
    updateTtsHint();
  }
  /* 声音按钮：文案 + 图标（内联 SVG）一起换 */
  function paintSoundBtn() {
    var b = $('btnSound');
    if (!b) return;
    setLabel(b, audio.on ? '声音开' : '声音关');
    setIcon(b, audio.on ? 'ic-sound-on' : 'ic-sound-off');
    b.setAttribute('aria-pressed', audio.on ? 'true' : 'false');
    b.classList.toggle('btn-on', audio.on);
  }
  function bindAudioUnlock() {
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, unlockAudio, { passive: true });
    });
    paintSoundBtn();
  }

  /* 语音自检提示（面板里显示；iOS 主屏 standalone 不支持 TTS 时告知用户该怎么办） */
  function updateTtsHint() {
    var el = $('ttsNote');
    if (!el) return;
    if (!audio.on) { el.textContent = ''; el.className = 'tts-note'; return; }
    if (audio.ttsOK) { el.textContent = '语音正常：到站/开门/关门/发车会朗读并显示字幕'; el.className = 'tts-note ok'; return; }
    if (audio.ttsSilent || audio.ttsError) {
      el.textContent = '系统语音不可用（iOS 主屏模式常见）：以提示音 + 字幕代替；用 Safari 打开同地址即有语音';
      el.className = 'tts-note warn';
      return;
    }
    el.textContent = '语音待触发…';
  }

  /* 报站文案（纯函数，便于自检） */
  function announceText(kind, ctxObj) {
    if (kind === 'open') return ctxObj.zh + '站到了，列车开门，请注意安全，请先下后上';
    if (kind === 'arrive') return ctxObj.zh + '站到了，请下车，注意列车与站台之间的空隙';
    if (kind === 'closing') return '车门即将关闭，请勿靠近车门';
    if (kind === 'depart') {
      var tag = ctxObj.loop ? '地铁' + ctxObj.line + '号线' + ctxObj.loopDir + '列车' : '地铁' + ctxObj.line + '号线';
      return '欢迎乘坐豆豆国' + tag + '，下一站 ' + ctxObj.next;
    }
    return '';
  }

  /* 发车报站用的“下一站”（停站中 nextIdx 还指向本车所在的站） */
  function nextStopAfter(tr) {
    var r = ROUTES[tr.routeKey];
    var i = r.ids.indexOf(tr.curId);
    if (i < 0) return null;
    var j = i + tr.dir;
    if (r.loop) {
      /* 环线：首尾相接，末站的下一站就是首站（不是终点） */
      if (j < 0) j = r.ids.length - 1;
      if (j >= r.ids.length) j = 0;
      return r.ids[j];
    }
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
      line: LINE_BY_KEY[r.lineKey].key,
      loop: !!r.loop,
      loopDir: r.loop ? dirName(r, st.dir) : ''
    };
    var text = kind === 'open' ? announceText('open', ctxObj)
      : kind === 'arrive' ? announceText('arrive', ctxObj)
        : kind === 'closing' ? announceText('closing', ctxObj)
          : (after ? announceText('depart', ctxObj) : '欢迎乘坐豆豆国地铁' + ctxObj.line + '号线，本次列车已到达终点站');
    /* 字幕：不管能不能出声都显示报站内容（iOS 主屏 standalone 对 TTS 有限制时也有反馈） */
    showAnnounce(text);
    if (!audio.on) return;
    /* 语音与倍速同步：任何倍速都朗读（rate 按倍率加速），只是正在说话时跳过下一条避免叠读 */
    if (kind === 'open' || kind === 'arrive') { chime('open'); speak(text); }
    else if (kind === 'closing') { chime('warn'); speak(text); }
    else { chime('close'); speak(text); }
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
    paintSoundBtn();
    if (audio.on) {
      var ctx = initAudio();
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
      bgmEnabled(true);
      speak('声音已开启，欢迎乘坐豆豆国的地铁');
    } else {
      bgmEnabled(false);
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
    $('spLine').textContent = (st.lines && st.lines.length ? st.lines.map(lineShort).join('·') : '1号线');
    $('spZh').textContent = st.zh;
    $('spEn').textContent = st.en || '';
    var tr = (st.lines && st.lines.length > 1)
      ? (st.lines.join('/') + ' 号线换乘')
      : ((st.tr && st.tr.length) ? (st.tr.map(function (k) { return k + ' 号线'; }).join('、')) : '无');
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
        $('spEtaLbl').textContent = '列车到达该站' + (timeRatio() !== 1 ? '（实时 ' + fmtDur(e.seconds / timeRatio()) + '）' : '');
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
    buildLegend();
    buildTrainPills();
    bindControls();
    bindVersionUI();
    bindAudioUnlock();
    initLegendFold();
    initStationSearch();
    initTabs();
    initSheet();
    buildStatCounts();
    updateTtsHint();
    resize();
    /* 抽屉默认半开：竖屏手机上「半开」的可见地图带（≈ 384px）刚好装得下整条线网，
       控件也同时可用；想看满屏地图就把把手往下拖到 peek */
    var smallPhone = sheetMode() && window.innerWidth < 560;
    applySnap('half');
    if (smallPhone) {                       // 小屏默认折叠 HUD 详情，把地图让出来
      $('hud').classList.add('folded');
      var hb = $('hudBrand');
      if (hb) hb.setAttribute('aria-expanded', 'false');
    }
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
      var dt = dtRaw * (ui.paused ? 0 : timeRatio());
      if (dt > 0) {
        trains.forEach(function (tr) {
          var left = dt, guard = 0;
          /* 子步上限 0.05s、最多 40 步 → 单帧最多推进 2s 仿真时间，
             足以支持 10x（帧间隔上限 0.12s × 10 = 1.2s），不会因帧内丢步而让高速变慢 */
          while (left > 1e-6 && guard++ < 40) {
            var sub = Math.min(left, 0.05);
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
      positionBubbles();        updateNextMarks(dtRaw);
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
    /* 抽屉/浮层的几何跟着视口尺寸走（拖动中不打断） */
    if (typeof sheet !== 'undefined' && !sheet.dragging) applySnap(sheet.snap);
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
        syncRouteSelect();
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
    if (map.speak) speak(decodeURIComponent(map.speak));
    if (map.panel === 'hide') {
      $('app').classList.add('panel-hidden');
      setLabel($('btnPanel'), '控制');
      setIcon($('btnPanel'), 'ic-panel');
    }
  }

  function bindControls() {
    $('btnPlay').addEventListener('click', function () {
      ui.paused = !ui.paused;
      setLabel(this, ui.paused ? '继续' : '暂停');
      setIcon(this, ui.paused ? 'ic-play' : 'ic-pause');
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
      setLabel(this, hidden ? '控制' : '收起');
      setIcon(this, hidden ? 'ic-panel' : 'ic-close');
      toast(hidden ? '已收起控制面板（点地图右上角「控制」可展开）' : '控制面板已展开');
      requestAnimationFrame(function () { resize(); });
    });
    $('hud').addEventListener('click', function (e) {
      if (e.target.closest('.hud-actions')) return;    // 按钮区不参与折叠
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
    $('btnSound').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();          // 不要触发 HUD 的折叠
      setSound(!audio.on);
    });
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
    /* 数据驱动：按线路 key 取它的第一个交路 key（现在线路多了，交路 key 不再都是 'Nmain'） */
    function svcOf(lineKey, idx) {
      var l = (M.lines || []).filter(function (x) { return x.key === lineKey; })[0];
      return l ? l.services[idx || 0].key : null;
    }
    var L2 = svcOf('2');
    var expectL1 = ['韦家碾', '升仙湖', '火车北站', '人民北路', '文殊院', '骡马市', '天府广场', '锦江宾馆', '华西坝',
      '省体育馆', '倪家桥', '桐梓林', '火车南站', '高新', '金融城', '孵化园', '锦城广场', '世纪城', '天府三街',
      '天府五街', '华府大道', '四河', '华阳', '海昌路', '广福', '红石公园', '麓湖', '武汉路', '天府公园', '西博城',
      '广州路', '兴隆湖', '科学城'];
    var expectL2 = ['犀浦', '天河路', '百草路', '金周路', '金科北路', '迎宾大道', '茶店子客运站', '羊犀立交',
      '一品天下', '蜀汉路东', '白果林', '中医大·省医院', '通惠门', '人民公园', '天府广场', '春熙路', '东门大桥',
      '牛王庙', '牛市口', '东大路', '塔子山公园', '成都东客站', '成渝立交', '惠王陵', '洪河', '成都行政学院',
      '龙泉驿火车站', '大面铺', '连山坡', '界牌', '书房', '龙平路', '龙泉驿'];
    function zh(key) { return ROUTES[key].ids.map(function (id) { return M.byId[id].zh; }); }
    var expectCounts = { '1': 33, '2': 32, '3': 37, '4': 30, '5': 41, '6': 56, '7': 31,
      '8': 32, '9': 13, '10': 18, '13': 21, '17': 21, '18': 13, '19': 23, '27': 22, '30': 24, 'S3': 6 };
    var loopSvc = Object.keys(ROUTES).filter(function (k) { return ROUTES[k].loop; });
    chk('环线（7 号线）：标记 loop、里程从首发站起算、环上每站只出现一次',
      loopSvc.length === 0 || (ROUTES[loopSvc[0]].kmAt[0] < 0.6 &&
        ROUTES[loopSvc[0]].label.indexOf('↔') > 0 &&
        ROUTES[loopSvc[0]].ids.length === 31 &&
        (function () { var seen = {}; return ROUTES[loopSvc[0]].ids.every(function (id) { if (seen[id]) return false; seen[id] = 1; return true; }); })() &&
        ROUTES[loopSvc[0]].ids[0] !== ROUTES[loopSvc[0]].ids[ROUTES[loopSvc[0]].ids.length - 1] &&
        M.byId[ROUTES[loopSvc[0]].ids[0]].zh === ROUTES[loopSvc[0]].label.split(' ↔ ')[0]),
      loopSvc.length ? (ROUTES[loopSvc[0]].label + ' km0=' + f2(ROUTES[loopSvc[0]].kmAt[0]) +
        ' 站数=' + ROUTES[loopSvc[0]].ids.length + ' 首站=' + M.byId[ROUTES[loopSvc[0]].ids[0]].zh) : '当前数据无环线');

    /* 环线绕一圈：不折返、末站到首站的闭合腿真的跑完（旧版在这里瞬移回起点） */
    chk('环线跑满一圈回到首站：不折返、里程 = 轨道全长（含闭合腿）', (function () {
      if (!loopSvc.length) return true;
      var key = loopSvc[0], r = ROUTES[key];
      var s = newTrain(key);
      var t = 0, flipped = false, maxPos = 0, left = false, back = false;
      while (t < 400000 && !back) {
        stepTrain(s, 0.5); t += 0.5;
        if (s.dir !== 1) flipped = true;
        if (s.posKm > maxPos) maxPos = s.posKm;
        if (s.curId !== r.ids[0]) left = true;
        if (left && s.curId === r.ids[0] && s.phase === 'dwell') back = true;
      }
      var odoKm = s.odometer;
      var reachEnd = maxPos > r.kmLength * 0.985;
      chk.__lap = '回到首站=' + back + ' 里程=' + f2(odoKm) + ' km / 一圈 ' + f2(r.kmLength) +
        ' km 方向翻转=' + flipped + ' 最远 s=' + f2(maxPos) + '/' + f2(r.kmLength) + ' 用时 ' + f2(t) + 's';
      return back && !flipped && reachEnd && Math.abs(odoKm - r.kmLength) < 0.6;
    })(), chk.__lap);

    /* 环线方向文案：成都地铁官方口径「内环 = 顺时针、外环 = 逆时针」 */
    chk('环线方向文案用「内环/外环」且与绕行方向对应；HUD/报站也带上它', (function () {
      if (!loopSvc.length) return true;
      var r = ROUTES[loopSvc[0]];
      var fwd = dirName(r, 1), back = dirName(r, -1);
      var hud = boundText({ routeKey: r.key, nextIdx: 1, dir: 1 });
      var line = LINE_BY_KEY[r.lineKey].key;
      var speak = announceText('depart', {
        zh: '', next: '二仙桥', line: line, loop: true, loopDir: fwd
      });
      chk.__loopdir = '正向=' + fwd + ' 反向=' + back + ' 数据绕行=' + (r.ccw ? '逆时针' : '顺时针') +
        ' HUD=' + hud + ' 报站=' + speak;
      return (fwd === '内环' || fwd === '外环') && (back === '内环' || back === '外环') && fwd !== back &&
        /^下一站/.test(hud) && speak.indexOf(fwd) >= 0 && /豆豆国地铁/.test(speak);
    })(), chk.__loopdir);

    var cntOk = M.lines.every(function (l) { var e = expectCounts[l.key]; return e === undefined || l.services[0].stationIds.length >= e - 1; });
    chk('每线路站数接近 OSM 关系站点数（1:33 2:32 3:37 4:30 5:41 6:56 7:31 8:32 9:13 10:18 13:21 17:21 18:13 19:23 27:22 30:24 S3:6）',
      cntOk && M.lines.length >= 17 && M.stations.length >= 300,
      '共 ' + M.stations.length + ' 站 · ' + M.lines.length + ' 条线路');
    chk('站名无重复', new Set(names).size === names.length);
    chk('1 号线主线顺序 = 官方列表（韦家碾→科学城）', zh('1main').join(',') === expectL1.join(','), zh('1main').length);
    chk('1 号线支线顺序 = 韦家碾…四河,广都,五根松',
      zh('1branch').join(',') === expectL1.slice(0, 22).concat(['广都', '五根松']).join(','), zh('1branch').length);
    var l2got = zh(L2);
    chk('2 号线顺序 = 犀浦→龙泉驿（OSM 线路关系）',
      l2got[0] === '犀浦' && l2got[l2got.length - 1] === '龙泉驿' && l2got.length >= 30,
      l2got.length + ' 站：' + l2got[0] + '…' + l2got[l2got.length - 1]);
    chk('换乘站由线路关系推导（天府广场 = 1/2 号线；多线时 > 10）', (function () {
      var shared = M.stations.filter(function (s) { return s.lines && s.lines.length > 1; });
      var tf = M.byId.tianfuguangchang;
      var enough = shared.length >= Math.max(1, M.lines.length - 2);
      return enough && !!tf && tf.lines.indexOf('1') >= 0 && tf.lines.indexOf('2') >= 0;
    })(), M.stations.filter(function (s) { return s.lines && s.lines.length > 1; }).length + ' 个换乘站 / ' + M.lines.length + ' 条线路');
    chk('1 号线里程 ≈ 37.5 km（OSM 轨道弧长）', Math.abs(ROUTES['1main'].kmLength - 37.45) < 0.6, f2(ROUTES['1main'].kmLength));
    chk('2 号线里程 ≈ 41.7 km', Math.abs(ROUTES[L2].kmLength - 41.66) < 0.8, f2(ROUTES[L2].kmLength));
    chk('每条交路起点里程 = 0（轨道已按首发站定向）', ROUTE_KEYS.every(function (k) { return ROUTES[k].kmAt[0] < 0.6; }),
      f2(ROUTES['1main'].kmAt[0]) + ' / ' + f2(ROUTES[L2].kmAt[0]) + ' / 共 ' + ROUTE_KEYS.length + ' 条交路');
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
        if (d > 25) onLine = false;
        if (i && r.kmAt[i] <= r.kmAt[i - 1]) mono = false;
      });
    });
    chk('站点均落在路径附近（偏差 < 25 单位；换乘站会偏离另一条线）', onLine, worstOn + ' 最大 ' + f2(worstOnD) + ' 单位');
    chk('站点到轨道最大投影误差 < 60 m（换乘站坐标只能落在其中一条线上）', maxProj < 60, f2(maxProj) + ' m');
    chk('站点里程单调递增', mono);
    chk('端点在路径两端（含折返线延长段）',
      ROUTES['1main'].mapAt[0] > 40 && ROUTES[L2].mapAt[0] > 40 &&
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
    var t = 0, stops = [], seenStops = {}, lastSeen = sim.curId, vmaxSeen = 0, reversed = false, dir0 = sim.dir;
    seenStops[sim.curId] = 1;
    while (t < 20000) {
      stepTrain(sim, 0.25); t += 0.25;
      vmaxSeen = Math.max(vmaxSeen, sim.v);
      if (sim.curId !== lastSeen) { lastSeen = sim.curId; stops.push(sim.curId); }
      seenStops[sim.curId] = 1;
      if (sim.dir !== dir0) { reversed = true; break; }
    }
    var visited = Object.keys(seenStops).length;
    chk('1 号线全程依次停靠 33 站（含终点）', visited === 33 && stops.indexOf('kexuecheng') >= 0,
      '停靠 ' + visited + ' 站，序列 ' + stops.length + ' 项，含科学城=' + (stops.indexOf('kexuecheng') >= 0));
    chk('不超过区间限速 60 km/h', vmaxSeen <= CFG.vmax + 1e-6, f2(vmaxSeen));
    chk('到达终点后折返换向', reversed, '折返后方向 ' + sim.dir + '，当前站 ' + (sim.curId ? M.byId[sim.curId].zh : '-'));
    chk('1 号线全程仿真时长合理（< 90 分钟）', t < 5400, f2(t / 60) + ' 分钟');

    /* 2 号线全程：在营 32 站停靠，在建的龙泉驿火车站不停靠 */
    var sim2l = cloneState();
    sim2l.routeKey = L2; sim2l.curId = 'xipu'; sim2l.posKm = 0; sim2l.dir = 1;
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
    sim2.routeKey = '1main'; sim2.curId = 'weijiannian';
    sim2.posKm = ROUTES['1main'].kmAt[0]; sim2.dir = 1; sim2.nextIdx = 1;
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
      setActive(0);
      if (state.routeKey !== '1main') switchService('1main', true);
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
    simEta.routeKey = '1main'; simEta.target = 'xibocheng';
    var te = 0;
    while (te < 20000) { stepTrain(simEta, 0.25); te += 0.25; if (simEta.curId === 'xibocheng' && simEta.phase === 'dwell') break; }
    var savedTarget = state.target, savedRoute = state.routeKey;
    state.routeKey = '1main';
    state.target = 'xibocheng';
    recomputeEta();
    var etaErr = Math.abs(state.eta - te);
    state.target = savedTarget; state.routeKey = savedRoute;
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

    chk('版本戳：在左下角图例里（不再有单独的角标）、内容非空、可点', (function () {
      var t = $('verText'), row = $('verRow'), badge = document.getElementById('verBadge');
      chk.__ver2 = '图例内=' + (!!row && !!$('legend') && $('legend').contains(row)) +
        ' 文本="' + (t ? t.textContent.trim() : '-') + '" 旧角标存在=' + !!badge;
      return !!t && !!row && $('legend').contains(row) && badge === null &&
        t.textContent.trim().length > 0 && /\d{4}-\d{2}-\d{2}|读取|未知/.test(t.textContent);
    })(), chk.__ver2);

    chk('版本戳已从 version.json 读取（http 环境）', (function () {
      var http = location.protocol === 'http:' || location.protocol === 'https:';
      if (!http) return true;                        // file:// 下 fetch 不可用，跳过
      return !!(BUILD_VERSION && BUILD_VERSION.version) && /^\d{4}-\d{2}-\d{2}/.test(BUILD_VERSION.version) &&
        /v\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}/.test($('verText').textContent);
    })(), BUILD_VERSION ? (BUILD_VERSION.version + ' · ' + BUILD_VERSION.commit) : '未读取');

    chk('点击「检查更新」不会把页面弄坏（已是最新时不重载）', (function () {
      var before = location.href;
      checkUpdate(false);
      return location.href === before;               // 同版本时只提示，不跳转
    })());

    chk('刷新/声音按钮内嵌在 HUD 里、高 ≥44px、图标是内联 SVG、文字不截断', (function () {
      var hudRect = $('hud').getBoundingClientRect(), lg = $('legend').getBoundingClientRect();
      var st = $('stage').getBoundingClientRect();
      var hard = $('btnHardRefresh'), snd = $('btnSound');
      var hr = hard.getBoundingClientRect(), sr = snd.getBoundingClientRect();
      var leftDiff = Math.abs(hudRect.left - lg.left);
      var topGap = hudRect.top - st.top, bottomGap = st.bottom - lg.bottom;
      var gapDiff = Math.abs(topGap - bottomGap);
      var clipped = [hard, snd].filter(function (b) {
        return b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1;
      }).length;
      var hasSvg = !!hard.querySelector('svg use') && !!snd.querySelector('svg use');
      chk.__hr = '左对齐差=' + leftDiff.toFixed(1) + 'px 上缝=' + topGap.toFixed(1) +
        ' 下缝=' + bottomGap.toFixed(1) + ' 按钮在HUD内=' + $('hud').contains(hard) + '/' + $('hud').contains(snd) +
        ' 尺寸=' + Math.round(hr.width) + 'x' + Math.round(hr.height) + ',' + Math.round(sr.width) + 'x' + Math.round(sr.height) +
        ' 图标=' + hasSvg + ' 文字截断=' + clipped;
      /* 宽度只要求 ≥64（= 44px 触控下限 + 图标与内边距）；以前卡 70/100 是 emoji 时代的字宽，
         那种阈值会把“换个图标就变窄”当成失败——真正要守的是“不截断 + 高≥44”。 */
      return $('hud').contains(hard) && $('hud').contains(snd) &&
        hr.height >= 44 && hr.width >= 64 && sr.height >= 44 && sr.width >= 64 &&
        hasSvg && clipped === 0 && leftDiff <= 1.5 && gapDiff <= 1.5;
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
      return here.length >= 1 && !!b && b.classList.contains('here');
    })(), chk.__lst);

    chk('站点列表按线路分组（每线一组、只展开当前列车所在线路、组内站数正确）', (function () {
      var cur = ROUTES[state.routeKey].lineKey;
      openGroupForLine(cur);
      var line = M.lines.filter(function (l) { return l.key === cur; })[0];
      var open = groupEls.filter(function (g) { return g.wrap.classList.contains('open'); });
      var okOpen = open.length === line.services.length && open.every(function (g) { return g.line === cur; });
      var okCount = groupEls.every(function (g) {
        var n = g.body.querySelectorAll('button[data-st]').length;
        return n > 0 && n <= ROUTES[g.svc].ids.length;
      });
      chk.__fold2 = groupEls.length + ' 组（期望 ' + ROUTE_KEYS.length + '）/ 展开 ' + open.length +
        ' 组（当前线路 ' + cur + ' 有 ' + line.services.length + ' 个交路）/ 组内站数正常=' + okCount;
      return groupEls.length === ROUTE_KEYS.length && okOpen && okCount;
    })(), chk.__fold2);

    chk('视口裁剪：放大到局部后绝大多数站名标签不参与显示（不被远处站拖慢/拖脏）', (function () {
      var bak = { k: view.k, tx: view.tx, ty: view.ty };
      zoomAt(0, 0, 1e6);
      clampView(); applyView(); updateLabelScale();
      var total = labelEls.length, off = 0, shown = 0;
      labelEls.forEach(function (L) {
        if (L.g.classList.contains('offscreen')) off++;
        if (L.vis && L.inView && !L.g.classList.contains('offscreen')) shown++;
      });
      view.k = bak.k; view.tx = bak.tx; view.ty = bak.ty;
      clampView(); applyView(); updateLabelScale();
      chk.__cull = '放大到局部：站名标签共 ' + total + ' 个，屏幕外 ' + off + ' 个，真正显示 ' + shown + ' 个';
      return total > 300 && off > total * 0.5 && shown < 60;
    })(), chk.__cull);

    /* 底图覆盖：远端新线附近必须有水系与道路（否则就是“底图没扩到”的回归） */
    chk('底图覆盖远端新线（兰家沟 / 龙泉驿 / 天府机场 / 资阳 等附近都有水系与道路）', (function () {
      var want = ['兰家沟', '龙泉驿', '天府机场北', '资阳北站', '西河', '龙安', '高洪', '花桥', '新平'];
      var box = 160;                       // 地图单位（1 km = unitsPerKm → 160 单位 ≈ 3.2 km）
      var res = [], ok = true;
      var waters = (M.water && M.water.rivers ? M.water.rivers : []).concat(M.water && M.water.lakes ? M.water.lakes : []);
      var roads = M.roads || [];
      want.forEach(function (zh) {
        var st = M.stations.filter(function (s) { return s.zh === zh; })[0];
        if (!st) { res.push(zh + '(无此站)'); ok = false; return; }
        var nw = 0, nr = 0, i;
        waters.forEach(function (f) {
          for (i = 0; i < f.pts.length; i++) {
            if (Math.abs(f.pts[i][0] - st.x) < box && Math.abs(f.pts[i][1] - st.y) < box) { nw++; break; }
          }
        });
        roads.forEach(function (rd) {
          for (i = 0; i < rd.pts.length; i++) {
            if (Math.abs(rd.pts[i][0] - st.x) < box && Math.abs(rd.pts[i][1] - st.y) < box) { nr++; break; }
          }
        });
        if (!nw || !nr) ok = false;
        res.push(zh + ' 河湖' + nw + '/路' + nr);
      });
      chk.__cover = res.join(' · ');
      return ok;
    })(), chk.__cover);

    chk('时间流逝比例：基础 1:2（现实 1s = 游戏 2s），倍速再乘', (function () {
      var bak = ui.mult;
      ui.mult = 1; var r1 = timeRatio();
      ui.mult = 2; var r2 = timeRatio();
      ui.mult = 10; var r10 = timeRatio();
      ui.mult = bak;
      chk.__time = '1x=' + r1 + 'x 2x=' + r2 + 'x 10x=' + r10 + 'x（基础 ' + TIME_BASE + '）';
      return TIME_BASE === 2 && r1 === 2 && r2 === 4 && r10 === 20;
    })(), chk.__time);

    chk('语音语速：1x≈0.95（听得清）、2x≈1.9、高倍速封顶 2', (function () {
      var desc = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
      var q = [], bakOn = audio.on, bakMult = ui.mult;
      var stub = {
        getVoices: function () { return []; },
        cancel: function () { },
        speak: function (u) { q.push(u.rate); if (u.onstart) u.onstart(); if (u.onend) setTimeout(u.onend, 0); }
      };
      try { Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true, writable: true }); }
      catch (e) { return true; }
      setSound(true);
      speechQ = []; speechBusy = false;
      q = [];
      ui.mult = 1; announce(state, 'open');
      ui.mult = 2; announce(state, 'closing');
      ui.mult = 10; announce(state, 'depart');
      var qr = speechQ.map(function (x) { return x.rate; });
      chk.__rate = '首条=' + (q[0] || '-') + ' 队列=' + qr.join(',');
      ui.mult = bakMult; setSound(bakOn);
      try { if (desc) Object.defineProperty(window, 'speechSynthesis', desc); } catch (e2) { void e2; }
      speechQ = []; speechBusy = false;
      return Math.abs(q[0] - 0.95) < 0.01 && qr.length === 2 &&
        Math.abs(qr[0] - 1.9) < 0.01 && qr[1] === 2;
    })(), chk.__rate);

    chk('语音不叠读：正在说时再报站只入队，不并发（避免听不清）', (function () {
      var desc = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
      var speaks = 0, bakOn = audio.on, bakMult = ui.mult;
      var stub = {
        getVoices: function () { return []; },
        cancel: function () { },
        speak: function () { speaks++; }          // 故意不触发 onend，模拟 iOS 不回调
      };
      try { Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true, writable: true }); }
      catch (e) { return true; }
      setSound(true);
      speechQ = []; speechBusy = false; speechSeq++;
      speaks = 0;
      ui.mult = 1;
      announce(state, 'open');
      announce(state, 'closing');
      announce(state, 'depart');
      var ok = speaks === 1 && speechQ.length === 2;
      chk.__nodup = 'speak 调用=' + speaks + ' 队列=' + speechQ.length;
      ui.mult = bakMult; setSound(bakOn);
      try { if (desc) Object.defineProperty(window, 'speechSynthesis', desc); } catch (e2) { void e2; }
      speechQ = []; speechBusy = false; speechSeq++;
      return ok;
    })(), chk.__nodup);

    chk('速度选项 = 1x/2x/5x/10x，且高倍速下子步不丢步', (function () {
      var btns = $('segSpeed').querySelectorAll('button');
      var mults = [].slice.call(btns).map(function (b) { return Number(b.getAttribute('data-mult')); });
      var want = [1, 2, 5, 10];
      var same = mults.length === want.length && mults.every(function (v, i) { return v === want[i]; });
      /* 10x 时单帧最大 0.12s × 10 = 1.2s，子步 0.05s 需 ≤ 24 步，留到 40 步够用 */
      var enough = Math.ceil(0.12 * 10 / 0.05) <= 40;
      var bak = ui.mult;
      btns[mults.length - 1].click();                 // 点 10x
      var clicked = ui.mult === 10;
      ui.mult = bak;
      chk.__spd = '按钮=' + mults.join('/') + ' 点10x后=' + clicked + ' 子步够用=' + enough;
      return same && clicked && enough;
    })(), chk.__spd);

    chk('渲染元素齐备（全部车站/标签 + 每线一列 8 车厢）',
      Object.keys(stationEls).length === M.stations.length && labelEls.length === M.stations.length &&
      trainGroups.length === trains.length && trainGroups.every(function (g) { return g.els.length === 8; }),
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

    chk('声音：默认关闭 + 开关内嵌在左上角 HUD 里、≥44px', (function () {
      var b = $('btnSound');
      if (!b) return false;
      var r = b.getBoundingClientRect();
      chk.__snd = 'text=' + b.textContent.trim() + ' size=' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' 在HUD内=' + $('hud').contains(b) + ' on=' + audio.on + ' aria=' + b.getAttribute('aria-pressed');
      return $('hud').contains(b) && r.height >= 44 && r.width >= 44 &&
        audio.on === false && b.getAttribute('aria-pressed') === 'false';
    })(), chk.__snd);

    /* 声音按钮的“状态”现在由内联 SVG 图标 + 文案 + aria-pressed 三重表达（以前靠 emoji） */
    function soundIconId() {
      var u = $('btnSound') && $('btnSound').querySelector('use');
      return u ? (u.getAttribute('href') || u.getAttribute('xlink:href') || '') : '';
    }

    chk('声音开关可用：开能建音频上下文与合成 BGM/铃音通道，并能恢复', (function () {
      var hasAC = typeof (window.AudioContext || window.webkitAudioContext) === 'function';
      if (!hasAC) return true;                              // 环境不支持就跳过
      var bak = audio.on;
      setSound(true);
      var onText = $('btnSound').textContent;
      var onIcon = soundIconId();
      setSound(false);
      var offText = $('btnSound').textContent;
      var offIcon = soundIconId();
      var ok = audio.on === false && !!audio.ctx && !!audio.bgmGain && !!audio.synth &&
        /声音开/.test(onText) && onIcon === '#ic-sound-on' &&
        /声音关/.test(offText) && offIcon === '#ic-sound-off' &&
        $('btnSound').getAttribute('aria-pressed') === 'false';
      setSound(bak);
      chk.__aud = 'ctx=' + !!audio.ctx + ' synth=' + !!audio.synth + ' bgmGain=' + !!audio.bgmGain +
        ' 已恢复=' + (audio.on === bak) + ' 默认=' + bak +
        ' 图标=' + onIcon + '→' + offIcon + ' 文案=' + onText.trim() + '→' + offText.trim();
      return ok && audio.on === bak;
    })(), chk.__aud);

    chk('列车强调显示：每列车有光晕 + 跟随标签（带线路与状态）', (function () {
      var want = trains.length;
      var halos = document.querySelectorAll('#trains .train-halo path');
      var pills = document.querySelectorAll('#trainpills .tp');
      var hasState = Array.prototype.every.call(pills, function (p) { return p.textContent.trim().length > 2; });
      chk.__emp = halos.length + ' 光晕 / ' + pills.length + ' 标签 / ' + hasState;
      return halos.length === want * CFG.cars && pills.length === want && hasState &&
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

    chk('列车数 = 每条线路 1 列（一线一车）', trains.length === M.lines.length &&
      new Set(trains.map(function (t) { return ROUTES[t.routeKey].lineKey; })).size === M.lines.length,
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
      var lk = LINE_BY_KEY[ROUTES[tr1.routeKey].lineKey].short;
      var ok = hit === 1 && activeIdx === 1 && $('selRoute').value === tr1.routeKey &&
        $('hudDir').textContent.indexOf(lk) >= 0 && document.querySelectorAll('#trainChips .tchip.on').length === 1;
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
      var act = document.querySelectorAll('#trains .train.active');
      return g.length === trains.length && act.length === 1 && act[0] === g[activeIdx];
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
      chk.__bub = wraps + ' 站 / ' + bubbles.length + ' 气泡 / ' + rings.length + ' 圈（列车 ' + trains.length + '）/ ' + hasTime;
      return wraps >= 1 && bubbles.length >= 1 && rings.length === trains.length && hasTime && visible;
    })(), chk.__bub);

    chk('同一站点多列车 → 气泡折叠为一条，点击展开全部，点空白收起', (function () {
      var a = trains[0], b = trains[1], bak = [snap(a), snap(b), activeIdx];
      var r1 = ROUTES['1main'], r2 = ROUTES[L2];
      var i1 = r1.ids.indexOf('tianfuguangchang'), i2 = r2.ids.indexOf('tianfuguangchang');
      a.routeKey = '1main'; a.curId = r1.ids[i1 - 1]; a.nextIdx = i1;
      a.posKm = r1.kmAt[i1] - 0.45; a.dir = 1; a.phase = 'run'; a.v = 40;
      b.routeKey = L2; b.curId = r2.ids[i2 - 1]; b.nextIdx = i2;
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
      setActive(0);
    if (state.routeKey !== '1main') switchService('1main', true);
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
          /* 长按（手指停留超过 tapMs）也要能选站，且不能误触发缩放。
             线路变多后整网适配得更远，屏幕中央往往正好被 HUD/图例/悬浮窗盖住，
             所以先挑一个“屏幕位置没被 HTML 覆盖件挡住”的站点（优先当前交路上的站，
             这样派车测试不会顺手切到别的列车）——测的是手势，不是遮挡。 */
          setTarget(null);
          closePopup();
          var pick = (function () {
            var cand = ROUTES['1main'].ids.concat(M.stations.map(function (s3) { return s3.id; }));
            for (var i = 0; i < cand.length; i++) {
              var s3 = M.byId[cand[i]];
              if (!s3) continue;
              var x = s3.x * view.k + view.tx, y = s3.y * view.k + view.ty;
              if (x < 36 || y < 36 || x > stage.w - 36 || y > stage.h - 36) continue;
              var el = document.elementFromPoint(x, y);
              if (!el || !el.closest || !el.closest('#stage')) continue;
              if (el.closest('#hud') || el.closest('#legend') || el.closest('#stpop') ||
                  el.closest('#scalebar') || el.closest('#compass')) continue;
              return { st: s3, x: x, y: y };
            }
            return null;
          })();
          chk('地图上存在未被 HUD/图例遮挡的站点（手势测试的前提）', !!pick,
            pick ? pick.st.zh + '@' + Math.round(pick.x) + ',' + Math.round(pick.y) + ' k=' + f2(view.k)
              : '整网适配后没有可用落点 k=' + f2(view.k));
          var sp2 = { x: pick ? pick.x : stage.w / 2, y: pick ? pick.y : stage.h / 2 };
          var pickId = pick ? pick.st.id : '';
          var kBeforeLong = view.k;
          pe('pointerdown', sp2.x, sp2.y, 41);
          setTimeout(function () {
            pe('pointerup', sp2.x, sp2.y, 41);
            setTimeout(function () {
              chk('长按（停留 > tapMs）也能选中站点', !!pick && popupId === pickId && Math.abs(view.k - kBeforeLong) < 1e-9,
                'popup=' + String(popupId) + ' 期望=' + pickId + ' k=' + f2(view.k));
              /* 用悬浮窗里的按钮派车 */
              $('spGo').click();
              setTimeout(function () {
                chk('悬浮窗“列车运行到该站”可派车', !!pick && state.target === pickId,
                  'target=' + String(state.target) + ' 期望=' + pickId + ', btn=' + $('spGo').textContent);
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

                /* ===== 新版控制区（tab + 抽屉）的契约 ===== */
                chk('tab 一次只开一个面板：aria-selected 唯一、对应 pane 可见、其余 hidden', (function () {
                  var names = ['lines', 'train', 'nav', 'stations'];
                  var ok = true, seen = [];
                  names.forEach(function (n) {
                    setTab(n);
                    var sel = document.querySelectorAll('#tabs .tab[aria-selected="true"]');
                    var pane = $('tab-' + n);
                    if (sel.length !== 1 || sel[0].id !== 'tabBtn-' + n) ok = false;
                    if (pane.hidden) ok = false;
                    names.forEach(function (m) { if (m !== n && !$('tab-' + m).hidden) ok = false; });
                    seen.push(n);
                  });
                  setTab('train');
                  chk.__tabs = seen.length + ' 个 tab 逐个切换正常；每个 tab 都对应一个 pane';
                  return ok && seen.length === names.length;
                })(), chk.__tabs);

                chk('触控目标 ≥44px（tab / 线路色块 / 站点行 / HUD 按钮）', (function () {
                  var bad = [];
                  function need(sel, label) {
                    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
                      if (el.offsetParent === null) return;      // 当前隐藏的 pane 不量
                      var r = el.getBoundingClientRect();
                      if (r.width < 44 || r.height < 44) bad.push(label + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
                    });
                  }
                  need('#tabs .tab', 'tab');
                  need('#hud .btn-mini', 'hudbtn');
                  need('#stlist button.row-btn', 'strow');
                  setTab('lines');
                  var nChip = document.querySelectorAll('#lgLines .lg-chip').length;
                  need('#lgLines .lg-chip', 'linechip');
                  setTab('train');
                  chk.__tap2 = bad.length ? bad.slice(0, 5).join(' ') : ('tab / ' + nChip + ' 个线路色块 / 站点行 / HUD 按钮全部 ≥44px');
                  return bad.length === 0 && nChip === M.lines.length;
                })(), chk.__tap2);

                chk('面板主体是唯一滚动归属（document 与舞台都不滚）', (function () {
                  var body = $('panelBody');
                  setTab('stations');
                  var docScrolled = window.scrollX !== 0 || window.scrollY !== 0 ||
                    document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0;
                  var bodyScrolls = body.scrollHeight > body.clientHeight;      // 366 站，必须可滚
                  var oy = getComputedStyle(body).overflowY;
                  var stageOverflow = getComputedStyle($('stage')).overflow;
                  setTab('train');
                  chk.__scroll = 'doc scrolled=' + docScrolled + ' panelBody ' + body.scrollHeight + '/' + body.clientHeight +
                    ' overflowY=' + oy + ' stage overflow=' + stageOverflow;
                  return !docScrolled && bodyScrolls && oy === 'auto' && stageOverflow === 'hidden';
                })(), chk.__scroll);

                chk('抽屉三档（peek/half/full）算得对，且收起时仍看得到把手与 tab', (function () {
                  var g = sheetGeom();
                  var hh = $('sheetHandle').offsetHeight, th = $('tabs').offsetHeight;
                  var peek = g.peek;
                  var out = [];
                  var ok = peek > 0 && Math.abs(peek - (hh + th)) <= 1 &&
                    g.peek <= g.half && g.half <= g.full && g.full <= g.panelH + 1;
                  /* 直接验 --sheet-t / --sheet-h 的算法（不依赖当前 CSS 是否处于抽屉模式） */
                  [['peek', g.peek], ['half', g.half], ['full', g.full]].forEach(function (pair) {
                    var vis = Math.max(g.peek, Math.min(g.panelH, pair[1]));
                    var t = g.panelH - vis;
                    out.push(pair[0] + ': 可见 ' + Math.round(vis) + ' t=' + Math.round(t));
                    if (t < -0.5 || t > g.panelH - g.peek + 0.5) ok = false;
                    if (vis < g.peek - 0.5) ok = false;
                  });
                  chk.__sheet = out.join('  ') + '（面板高 ' + Math.round(g.panelH) + '，把手+tab=' + (hh + th) + '）';
                  return ok;
                })(), chk.__sheet);

                chk('站点搜索：搜得到（中/英）、结果可点、清空后回到按线折叠', (function () {
                  var inp = $('stSearch');
                  if (!inp) return false;
                  setTab('stations');
                  inp.value = '天府广场';
                  renderStationList();
                  var hits = $('stlist').querySelectorAll('button[data-st]');
                  var first = hits.length ? hits[0].getAttribute('data-st') : '';
                  var okZh = hits.length === 1 && first === 'tianfuguangchang';
                  inp.value = 'Tianfu Square';
                  renderStationList();
                  var okEn = $('stlist').querySelectorAll('button[data-st]').length >= 1;
                  inp.value = '';
                  renderStationList();
                  var groups = $('stlist').querySelectorAll('.stgrp').length;
                  var open = $('stlist').querySelectorAll('.stgrp.open').length;
                  setTab('train');
                  chk.__search = '中文命中=' + (okZh ? 1 : 0) + ' 英文命中=' + (okEn ? 1 : 0) +
                    ' 清空后恢复 ' + groups + ' 组（展开 ' + open + '）';
                  return okZh && okEn && groups === ROUTE_KEYS.length && open >= 1;
                })(), chk.__search);
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
                /* 真实回归：模拟 iOS 引擎（onend 稍后才触发），连报“到站/关门/发车”三条
                   断言三条都被说出来（之前用 speechSynthesis.speaking 判断，iOS 上会卡住导致后两条全丢） */
                var desc2 = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
                var spoken = [], bakOn2 = audio.on, bakMult2 = ui.mult;
                var stub2 = {
                  getVoices: function () { return []; },
                  cancel: function () { spoken.push('CANCEL'); },
                  speak: function (u) {
                    spoken.push(u.text);
                    if (u.onstart) u.onstart();
                    setTimeout(function () { if (u.onend) u.onend(); }, 30);
                  }
                };
                try { Object.defineProperty(window, 'speechSynthesis', { value: stub2, configurable: true, writable: true }); } catch (e0) { void e0; }
                setSound(true);
                speechQ = []; speechBusy = false;
                spoken = [];
                ui.mult = 1;
                announce(state, 'open');
                announce(state, 'closing');
                announce(state, 'depart');
                setTimeout(function () {
                  var ok = spoken.length === 3 && spoken.indexOf('CANCEL') < 0 &&
                    /站到了/.test(spoken[0]) && /车门即将关闭/.test(spoken[1]) &&
                    /豆豆国地铁/.test(spoken[2]) && /下一站/.test(spoken[2]);
                  chk('连报三条（到站/关门/发车）都会说出，不漏、不 cancel', ok,
                    spoken.map(function (t2) { return t2.slice(0, 10); }).join(' / '));
                  ui.mult = bakMult2;
                  setSound(bakOn2);
                  try { if (desc2) Object.defineProperty(window, 'speechSynthesis', desc2); } catch (e3) { void e3; }
                  speechQ = []; speechBusy = false;
                  done();
                }, 900);
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
    applySnap: applySnap, setTab: setTab, renderStationList: renderStationList, sheet: sheet,
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
    reservedBoxes: reservedBoxes, updateTtsHint: updateTtsHint, unlockAudio: unlockAudio,
    applyLineFilter: applyLineFilter, buildLegend: buildLegend, lineElems: lineElems, lineVisible: lineVisible,
    trainIndexForLine: trainIndexForLine, updateStationList: updateStationList, scrollListToActive: scrollListToActive
  };
})();
