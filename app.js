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
    openT: 0.9,            // 开门动画 s
    holdT: 1.8,            // 开门保持 s
    closeT: 0.9,           // 关门动画 s
    readyT: 0.5,           // 关门后确认 s
    reverseT: 12,          // 终点站折返 s
    cars: 3,
    carLen: 14,            // 车厢长度（地图单位，示意夸张）
    carGap: 1.8,           // 车厢间隙
    carHW: 5.0,            // 车厢半宽
    platHalf: 12,          // 站台长度的一半（地图单位）
    platHW: 7.5,           // 站台半宽
    stub: 86,              // 端点站外的折返线长度（地图单位）
    tapRadius: 26,         // 站点命中半径（屏幕 px，直径 52 >= 44）
    tapMove: 12,           // 判定为拖动的最小位移（屏幕 px）
    tapMs: 800,            // 判定为点击的最大时长（ms），超过视为长按
    dblMs: 320,            // 双击间隔
    fadeLabels: 0.60       // 低于该缩放只显示重点站名
  };

  var VIEW_MARGIN = { x: 170, y: 130 };   // 适配视图时线路四周的留白（地图单位）

  /* --------------------------------------------------------------- 运行时状态 */
  var state = {
    paused: false, mult: 1, follow: false,
    routeKey: 'main', dir: 1,
    posKm: 0, v: 0,
    phase: 'dwell', phaseT: 0,
    doorPhase: 'closed', door: 0,
    curId: null, nextIdx: 1,
    target: null,
    odometer: 0,
    eta: null, etaStops: 0,
    lastTargetToast: null
  };

  var selected = null;          // 面板里选中的站点 id
  var view = { k: 1, tx: 0, ty: 0, fitted: true };
  var stage = { w: 800, h: 600 };
  var ready = false;

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
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fmtKm(km) { return km.toFixed(2) + ' km'; }
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
  function haversine(a, b) {
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180,
      dLon = (b.lon - a.lon) * Math.PI / 180,
      la = (a.lat + b.lat) / 2 * Math.PI / 180;
    return R * Math.hypot(dLat, Math.cos(la) * dLon);
  }

  /* =========================================================== 1. 路径采样 */
  /* Catmull-Rom（转三次贝塞尔）经过所有顶点，再细采样成折线表并累计弧长。 */
  function cubic(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
    };
  }

  function buildSection(pts) {
    var n = pts.length, samples = [], vIdx = [0], d = '', i, k;
    function P(i) { return pts[clamp(i, 0, n - 1)]; }
    samples.push({ x: pts[0].x, y: pts[0].y });
    d = 'M' + f2(pts[0].x) + ' ' + f2(pts[0].y);
    for (i = 0; i < n - 1; i++) {
      var p0 = P(i - 1), p1 = pts[i], p2 = pts[i + 1], p3 = P(i + 2);
      var chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      var steps = clamp(Math.round(chord / 1.1), 10, 90);
      for (k = 1; k <= steps; k++) samples.push(cubic(p0, p1, p2, p3, k / steps));
      vIdx.push(samples.length - 1);
      d += 'C' + f2(p1.x + (p2.x - p0.x) / 6) + ' ' + f2(p1.y + (p2.y - p0.y) / 6) +
        ' ' + f2(p2.x - (p3.x - p1.x) / 6) + ' ' + f2(p2.y - (p3.y - p1.y) / 6) +
        ' ' + f2(p2.x) + ' ' + f2(p2.y);
    }
    var cum = [0];
    for (i = 1; i < samples.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    }
    return { pts: pts, samples: samples, cum: cum, vIdx: vIdx, length: cum[cum.length - 1], d: d };
  }

  /* 由站点序列生成一段线路（首尾可加折返线延长段） */
  function sectionFrom(ids) {
    var pts = [];
    if (ids.length > 1) {
      var p0 = M.byId[ids[0]], p1 = M.byId[ids[1]];
      var dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1;
      pts.push({ id: null, x: p0.x - dx / L * CFG.stub, y: p0.y - dy / L * CFG.stub });
    }
    ids.forEach(function (id) {
      var s = M.byId[id];
      pts.push({ id: id, x: s.x, y: s.y });
    });
    if (ids.length > 1) {
      var q0 = M.byId[ids[ids.length - 2]], q1 = M.byId[ids[ids.length - 1]];
      var ex = q1.x - q0.x, ey = q1.y - q0.y, EL = Math.hypot(ex, ey) || 1;
      pts.push({ id: null, x: q1.x + ex / EL * CFG.stub, y: q1.y + ey / EL * CFG.stub });
    }
    return buildSection(pts);
  }

  var SEC = {
    trunk: sectionFrom(M.trunk),
    mainTail: sectionFrom(M.mainTail),
    eastTail: sectionFrom(M.eastTail)
  };

  /* 拼接分段成完整交路（分叉站几何共用，交点处不重复采点） */
  function assembleRoute(sections) {
    var samples = [], marks = [], i, k;
    sections.forEach(function (sec, si) {
      var from = si === 0 ? 0 : 1;
      marks.push({ sec: sec, start: samples.length - from });
      for (k = from; k < sec.samples.length; k++) samples.push(sec.samples[k]);
    });
    var cum = [0];
    for (i = 1; i < samples.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    }
    var route = { samples: samples, cum: cum, length: cum[cum.length - 1], ids: [], mapAt: [], kmAt: [] };
    marks.forEach(function (m, mi) {
      m.sec.pts.forEach(function (pt, vi) {
        if (!pt.id) return;
        if (mi > 0 && vi === 0) return;              // 分叉站已在上一段记录
        if (route.ids.indexOf(pt.id) >= 0) return;   // 防止重复站点
        route.ids.push(pt.id);
        route.mapAt.push(cum[m.start + m.sec.vIdx[vi]]);
      });
    });
    return route;
  }

  var ROUTES = {
    main: assembleRoute([SEC.trunk, SEC.mainTail]),
    branch: assembleRoute([SEC.trunk, SEC.eastTail])
  };
  ROUTES.main.label = '韦家碾 ↔ 科学城';
  ROUTES.branch.label = '韦家碾 ↔ 五根松';

  /* 里程标定：站点间用球面距离，再整体缩放使“主线 + 支线”合计数 = 官方 41 km */
  var geoRaw = { main: 0, branch: 0, junction: 0 };
  (function calibrate() {
    function fill(route) {
      var sum = 0;
      route.geoRawAt = [0];
      for (var i = 1; i < route.ids.length; i++) {
        sum += haversine(M.byId[route.ids[i - 1]], M.byId[route.ids[i]]);
        route.geoRawAt.push(sum);
      }
      return sum;
    }
    geoRaw.main = fill(ROUTES.main);
    geoRaw.branch = fill(ROUTES.branch);
    var j = ROUTES.branch.ids.indexOf(M.junctionId);
    geoRaw.junction = ROUTES.branch.geoRawAt[j];
    var total = geoRaw.main + (geoRaw.branch - geoRaw.junction);
    var scale = M.lineLengthKm / total;
    Object.keys(ROUTES).forEach(function (key) {
      var r = ROUTES[key];
      r.kmAt = r.geoRawAt.map(function (v) { return v * scale; });
      r.kmLength = r.kmAt[r.kmAt.length - 1];
    });
  })();

  var ROUTE_TERMINUS = {
    main: ROUTES.main.ids[ROUTES.main.ids.length - 1],
    branch: ROUTES.branch.ids[ROUTES.branch.ids.length - 1]
  };

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

  /* ======================================================= 2. 底图装饰（示意） */
  var MAPBOX = { x: -1150, y: -110, w: 3160, h: 2330 };

  function buildBackground(world) {
    var rnd = mulberry(20260318);
    var g = svg('g', { id: 'bg' }, world);

    /* 城市纹理 pattern */
    var defs = svg('defs', null, g);
    var pat = svg('pattern', { id: 'cityTex', width: 150, height: 150, patternUnits: 'userSpaceOnUse' }, defs);
    var i;
    for (i = 0; i < 6; i++) {
      var bw = 26 + rnd() * 44, bh = 16 + rnd() * 30;
      svg('rect', {
        x: f1(rnd() * (150 - bw)), y: f1(rnd() * (150 - bh)),
        width: f1(bw), height: f1(bh), rx: 3,
        fill: i % 3 === 0 ? '#eae5d9' : '#eee9dd'
      }, pat);
    }
    svg('rect', { x: MAPBOX.x, y: MAPBOX.y, width: MAPBOX.w, height: MAPBOX.h, fill: 'url(#cityTex)' }, g);

    /* 网格 */
    var grid = svg('g', null, g);
    for (i = Math.ceil(MAPBOX.x / 200) * 200; i < MAPBOX.x + MAPBOX.w; i += 200) {
      svg('line', { class: 'bg-grid', x1: i, y1: MAPBOX.y, x2: i, y2: MAPBOX.y + MAPBOX.h }, grid);
    }
    for (i = Math.ceil(MAPBOX.y / 200) * 200; i < MAPBOX.y + MAPBOX.h; i += 200) {
      svg('line', { class: 'bg-grid', x1: MAPBOX.x, y1: i, x2: MAPBOX.x + MAPBOX.w, y2: i }, grid);
    }

    var roads = svg('g', null, g);
    function road(pts, w, dash) {
      var d = 'M' + pts.map(function (p) { return p[0] + ' ' + p[1]; }).join('L');
      svg('path', { class: 'bg-road-casing', d: d, 'stroke-width': w + 3 }, roads);
      svg('path', { class: 'bg-road', d: d, 'stroke-width': w }, roads);
      if (dash) svg('path', { class: 'bg-road-dash', d: d, 'stroke-width': 1.6 }, roads);
    }
    /* 主要东西向干道（示意） */
    var crosses = [
      [330, 0.05, 14], [560, -0.12, 12], [700, 0.02, 22], [860, 0.05, 18],
      [1060, -0.04, 12], [1270, 0.03, 20], [1470, -0.02, 14], [1660, 0.04, 12],
      [1830, 0.0, 18], [130, -0.03, 12]
    ];
    crosses.forEach(function (c) {
      road([[MAPBOX.x, c[0] + c[1] * 200], [MAPBOX.x + MAPBOX.w, c[0] - c[1] * 120]], c[2], c[2] >= 18);
    });
    /* 南北向干道（示意） */
    [
      [210, 8], [600, 10], [860, 8], [1250, 6], [1620, 6]
    ].forEach(function (c) {
      road([[c[0], MAPBOX.y], [c[0] + 40, MAPBOX.y + MAPBOX.h]], c[1], false);
    });

    /* 公园 */
    var parks = [[520, 185, 110, 62], [548, 1500, 130, 86], [660, 1880, 120, 80], [560, 300, 90, 56]];
    parks.forEach(function (p) {
      svg('ellipse', { class: 'bg-park', cx: p[0], cy: p[1], rx: p[2], ry: p[3] }, g);
    });

    /* 河流（府河/锦江、沙河、湖体；示意形状） */
    var water = svg('g', null, g);
    svg('path', {
      class: 'bg-water',
      d: 'M700 -90 C600 90, 540 220, 470 340 C400 460, 330 540, 306 660 ' +
        'C286 780, 320 900, 390 1020 C470 1160, 540 1320, 600 1520 C670 1760, 720 1980, 800 2210'
    }, water);
    svg('path', {
      class: 'bg-stream',
      d: 'M560 40 C520 150, 470 240, 430 330 C400 400, 380 470, 366 560'
    }, water);
    svg('ellipse', { class: 'bg-lake', cx: 530, cy: 214, rx: 62, ry: 24 }, water);      // 升仙湖
    svg('ellipse', { class: 'bg-lake', cx: 560, cy: 1560, rx: 78, ry: 32 }, water);     // 麓湖
    svg('ellipse', { class: 'bg-lake', cx: 700, cy: 1890, rx: 116, ry: 46 }, water);    // 兴隆湖
    svg('ellipse', { class: 'bg-lake', cx: 632, cy: 1720, rx: 62, ry: 24 }, water);     // 天府公园水景

    /* 水系标注 */
    var wlab = svg('g', null, g);
    [['沙河', 452, 250, 52], ['锦江（府南河）', 400, 950, 74], ['兴隆湖', 700, 1960, 0], ['麓湖', 560, 1620, 0], ['升仙湖', 530, 262, 0]]
      .forEach(function (t) {
        var el = svg('text', { class: 'bg-label', x: t[1], y: t[2], 'text-anchor': 'middle' }, wlab);
        if (t[3]) el.setAttribute('transform', 'rotate(' + t[3] + ' ' + t[1] + ' ' + t[2] + ')');
        el.textContent = t[0];
        bgLabels.push(el);
      });

    /* 局部街区（沿线路两侧，增强城市感；避开线路走廊） */
    var near = svg('g', null, g);
    for (i = 0; i < 170; i++) {
      var cx = 190 + rnd() * 560, cy = 40 + rnd() * 1940;
      var w0 = 30 + rnd() * 78, h0 = 20 + rnd() * 44;
      var axis = 400 + (cy - 200) * (100 / 1700);
      if (Math.abs(cx - axis) < 66) continue;
      if (cy > 1230 && cy < 1400 && cx < 600 && cx > axis - 30) continue;
      svg('rect', {
        class: 'bg-block' + (i % 3 === 0 ? ' alt' : ''), rx: 3,
        x: f1(cx), y: f1(cy), width: f1(w0), height: f1(h0),
        transform: 'rotate(' + f1((rnd() - 0.5) * 8) + ' ' + f1(cx) + ' ' + f1(cy) + ')'
      }, near);
    }
  }

  /* ==================================================== 3. 线路 / 车站 / 标签 */
  var world, railLayers = {}, stationEls = {}, labelEls = [], labelScale = 1, railGroup = null;
  var labelBoxes = [], bgLabels = [];

  function buildRail() {
    var g = svg('g', { id: 'rails' }, world);
    railGroup = g;
    Object.keys(SEC).forEach(function (key) {
      var sec = SEC[key];
      var d = 'M' + sec.samples.map(function (p) { return f1(p.x) + ' ' + f1(p.y); }).join('L');
      var cls = 'rail' + (key === 'eastTail' ? ' rail-branch' : '');
      svg('path', { class: 'rail-bed', d: d, 'stroke-width': 15 }, g);
      var path = svg('path', { class: cls, d: d, 'stroke-width': 10.5 }, g);
      if (key === 'eastTail') path.setAttribute('stroke-dasharray', '0');
      railLayers[key] = path;
    });
    /* 四河分叉点标记 */
    var j = M.byId[M.junctionId];
    svg('circle', { class: 'junction', cx: f1(j.x), cy: f1(j.y), r: 4.2 }, g);
  }

  function buildStations() {
    var gPlat = svg('g', { id: 'platforms' }, world);
    var gSt = svg('g', { id: 'stations' }, world);
    if (railGroup && railGroup.parentNode === world) world.insertBefore(gPlat, railGroup);   // 站台在轨道下方，只从两侧露出
    M.stations.forEach(function (st) {
      var mapS = stationMapS(st.id);
      var plat = svg('path', {
        class: 'platform',
        d: bandPath(routeOf(st.id), mapS + CFG.platHalf, mapS - CFG.platHalf, 0, CFG.platHW, 10)
      }, gPlat);
      plat.setAttribute('data-st', st.id);
      var r = st.tr.length ? 6.4 : (st.term ? 6.0 : 5.0);
      var dotG = svg('g', { 'data-st': st.id }, gSt);
      if (st.tr.length) {
        svg('circle', { class: 'st ring', cx: f1(st.x), cy: f1(st.y), r: r }, dotG);
        svg('circle', { class: 'st ring2', cx: f1(st.x), cy: f1(st.y), r: r + 3.4 }, dotG);
      } else {
        var dot = svg('circle', { class: 'st' + (st.term ? ' term' : ''), cx: f1(st.x), cy: f1(st.y), r: r }, dotG);
        if (st.branch) dot.classList.add('branch-st');
      }
      stationEls[st.id] = dotG;
    });
  }

  /* 站台带 / 站点在路径上的弧长位置（地图单位） */
  function stationMapS(id) {
    var route = routeOf(id);
    var i = route.ids.indexOf(id);
    return route.mapAt[i];
  }
  function stationKm(id) {
    var route = routeOf(id);
    var i = route.ids.indexOf(id);
    return route.kmAt[i];
  }
  function routeOf(id) {
    if (M.byId[id] && M.byId[id].branch) return ROUTES.branch;
    return ROUTES.main;
  }
  function routeKeyOf(id) { return (M.byId[id] && M.byId[id].branch) ? 'branch' : 'main'; }

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
    labelScale = clamp(1 / view.k, 0.34, 2.2);
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
  var trainEls = [];

  function buildTrain() {
    var g = svg('g', { id: 'train' }, world);
    var shadow = svg('g', { class: 'train-shadow', transform: 'translate(2.2,3.2)' }, g);
    var cars = svg('g', null, g);
    var i;
    for (i = 0; i < CFG.cars; i++) {
      var sh = svg('path', null, shadow);
      var car = svg('g', null, cars);
      var bodyCls = 'car-body' + (i === 0 ? ' head' : '');
      trainEls.push({
        shadow: sh,
        body: svg('path', { class: bodyCls }, car),
        nose: i === 0 ? svg('path', { class: 'car-nose' }, car) : null,
        stripe: svg('path', { class: 'car-stripe' }, car),
        win: svg('path', { class: 'car-win' }, car),
        door: svg('path', { class: 'car-door-leaf' }, car),
        gap: svg('path', { class: 'car-gap' }, car)
      });
    }
  }

  function noseProfile(i) {
    if (i === 0) return function (u) { return u < 0.16 ? 0.5 + 0.5 * (u / 0.16) : 1; };
    return function () { return 1; };
  }
  function tailProfile(i, total) {
    if (i === total - 1) return function (u) { return u > 0.9 ? 1 - 0.2 * ((u - 0.9) / 0.1) : 1; };
    return function () { return 1; };
  }

  function renderTrain() {
    var route = ROUTES[state.routeKey];
    var sHead = kmToMap(route, state.posKm);
    var dir = state.dir;
    var total = CFG.cars;
    for (var i = 0; i < total; i++) {
      var fS = sHead - dir * i * (CFG.carLen + CFG.carGap);
      var rS = fS - dir * CFG.carLen;
      var prof = function (u) { return noseProfile(i)(u) * tailProfile(i, total)(u); };
      var body = bandPath(route, fS, rS, 0, CFG.carHW, 14, prof);
      var el = trainEls[i];
      el.body.setAttribute('d', body);
      el.shadow.setAttribute('d', bandPath(route, fS, rS, 0, CFG.carHW * 1.12, 12, prof));
      /* 顶部蓝色色带 */
      el.stripe.setAttribute('d', bandPath(route, fS + dir * -CFG.carLen * 0.1, rS + dir * CFG.carLen * 0.1, 0, CFG.carHW * 0.17, 8));
      /* 车窗（两侧各 4 扇，尺寸随车长折算） */
      var winHalf = CFG.carLen * 0.115;
      var wins = '';
      [0.30, 0.45, 0.60, 0.74].forEach(function (u) {
        var c = fS + (rS - fS) * u;
        wins += bandPath(route, c + winHalf, c - winHalf, CFG.carHW * 0.62, CFG.carHW * 0.17, 3) + ' ';
        wins += bandPath(route, c + winHalf, c - winHalf, -CFG.carHW * 0.62, CFG.carHW * 0.17, 3) + ' ';
      });
      el.win.setAttribute('d', wins);
      /* 车门（两侧各 2 组，开门时叶片沿车身滑动分离） */
      var doorHalf = CFG.carLen * 0.093;
      var dOpen = state.door * CFG.carLen * 0.083;
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
  }

  /* ==================================================== 5. 运行状态机 */
  function routeIds(key) { return ROUTES[key].ids; }
  function idxOf(id) { return routeIds(state.routeKey).indexOf(id); }
  function terminusId() { return ROUTE_TERMINUS[state.routeKey]; }

  function resetState(keepTarget) {
    var tgt = keepTarget ? state.target : null;
    state.routeKey = 'main';
    state.dir = 1;
    state.posKm = 0;
    state.v = 0;
    state.phase = 'dwell';
    state.phaseT = 0;
    state.doorPhase = 'opening';
    state.door = 0;
    state.curId = ROUTES.main.ids[0];
    state.nextIdx = 1;
    state.odometer = 0;
    state.target = tgt;
    state.eta = null; state.etaStops = 0;
    state.lastTargetToast = null;
    recomputeEta();
  }

  function startReverse(st) {
    st.phase = 'reverse';
    st.phaseT = 0;
    st.v = 0;
    if (!st.silent) toast('到达 ' + M.byId[st.curId].zh + '（终点站），折返换向中…');
  }

  function planNext(st) {
    var route = ROUTES[st.routeKey];
    var i = route.ids.indexOf(st.curId);
    var last = route.ids.length - 1;
    var term = st.dir > 0 ? last : 0;

    /* 需要换交路：在分叉站（四河）切换 */
    if (st.target && routeKeyOf(st.target) !== st.routeKey) {
      var jj = route.ids.indexOf(M.junctionId);
      if (i === jj) {
        st.routeKey = routeKeyOf(st.target);
        route = ROUTES[st.routeKey];
        i = route.ids.indexOf(st.curId);
        st.posKm = route.kmAt[i];
        if (!st.silent) toast('在四河站切换交路 → ' + route.label);
      }
    }

    function goRun(idx) { st.nextIdx = idx; st.phase = 'run'; st.v = 0; }

    if (st.target) {
      var ti = route.ids.indexOf(st.target);
      if (ti >= 0) {
        var ahead = st.dir > 0 ? ti > i : ti < i;
        if (ahead) return goRun(i + st.dir);
        if (i !== term) return goRun(i + st.dir);     // 目标在身后：先到终点站
        return startReverse(st);
      }
      var j = route.ids.indexOf(M.junctionId);
      var jAhead = st.dir > 0 ? j > i : j < i;
      if (jAhead || i !== term) return goRun(i + st.dir);
      return startReverse(st);
    }
    if (i === term) return startReverse(st);
    return goRun(i + st.dir);
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
    if (st.target && st.target === st.curId) {
      st.target = null;
      st.eta = null; st.etaStops = 0;
      if (!st.silent) toast('已到达目标站：' + M.byId[st.curId].zh);
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

  function cloneState() {
    var o = {};
    for (var k in state) o[k] = state[k];
    o.silent = true;
    return o;
  }

  function recomputeEta() {
    if (!state.target) { state.eta = null; state.etaStops = 0; return; }
    var sim = cloneState();
    var target = state.target;
    var t = 0, steps = 0, stops = 0, prev = sim.curId;
    while (steps++ < 60000) {
      stepTrain(sim, 0.25);
      t += 0.25;
      if (sim.curId !== prev) { stops++; prev = sim.curId; }
      if (sim.curId === target && sim.phase === 'dwell') break;
    }
    if (steps >= 60000) { state.eta = null; state.etaStops = 0; return; }
    state.eta = t;                          // 游戏内秒数
    state.etaStops = stops;
  }

  function setTarget(id) {
    if (!id) { state.target = null; state.eta = null; state.etaStops = 0; return; }
    state.target = id;
    selected = id;
    recomputeEta();
    var st = M.byId[id];
    var msg;
    if (state.curId === id) msg = '列车已在 ' + st.zh + ' 站';
    else {
      var behind = false;
      if (routeKeyOf(id) === state.routeKey) {
        var route = ROUTES[state.routeKey];
        var ti = route.ids.indexOf(id), ci = route.ids.indexOf(state.curId);
        behind = state.dir > 0 ? ti < ci : ti > ci;
      } else {
        behind = true;
      }
      msg = '导航至 ' + st.zh + ' 站' + (behind ? '（需先折返/换交路）' : '') + '，预计 ' +
        (state.eta != null ? fmtDur(state.eta) : '较长');
    }
    toast(msg);
    updateStationInfo();
    updateStationList();
  }

  /* ==================================================== 6. 视图（Pointer Events） */
  var pointers = new Map(), gesture = null, lastTap = { t: 0, x: 0, y: 0 }, tapTimer = null;

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
    return {
      x0: x0 - VIEW_MARGIN.x, y0: y0 - VIEW_MARGIN.y,
      x1: x1 + VIEW_MARGIN.x, y1: y1 + VIEW_MARGIN.y
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

  function localPos(e) {
    var r = $('map').getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
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
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
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
    var dur = gesture ? (performance.now() - gesture.startT) : 0;
    var still = gesture && gesture.mode === 'tap' && gesture.moved <= CFG.tapMove;
    var wasTap = still && dur <= CFG.tapMs;          // 位移阈值 + 时间阈值
    var wasLong = still && dur > CFG.tapMs;
    var pos = localPos(e);
    if (gesture && gesture.mode === 'pinch') { updateLabelScale(); }
    gesture = pointers.size ? null : gesture;
    if (!wasTap) {
      gesture = null;
      if (wasLong && hitStation(pos)) toast('长按不选站：请轻点站点');
      return;
    }
    gesture = null;
    var now = performance.now();
    var isDouble = (now - lastTap.t) < CFG.dblMs && Math.hypot(pos.x - lastTap.x, pos.y - lastTap.y) < 34;
    if (isDouble) {
      lastTap.t = 0;
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
      zoomAt(pos.x, pos.y, 1.9);
      return;
    }
    lastTap = { t: now, x: pos.x, y: pos.y };
    var hit = hitStation(pos);
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
    tapTimer = setTimeout(function () {
      tapTimer = null;
      if (hit) setTarget(hit);
    }, hit ? 240 : 0);
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
    if (state.follow === on) { $('chkFollow').checked = on; return; }
    state.follow = on;
    $('chkFollow').checked = on;
    if (on) {
      var k = clamp(Math.max(view.k, 3.0), minZoom(), 16);
      zoomAt(stage.w / 2, stage.h / 2, k / view.k);
      followStep(0, true);          // 立即对中到列车，避免开启动画期间看不到车
    }
  }

  function followStep(dt, snap) {
    if (!state.follow) return;
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
    if (state.paused) return '已暂停';
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
    setText('hudDir', '往' + M.byId[ROUTE_TERMINUS[state.routeKey]].zh + ' · ' + (state.dir > 0 ? '下行' : '上行'));
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
    setText('tgEta', state.eta != null ? fmtDur(state.eta) + '（实时 ' + fmtDur(state.eta / state.mult) + '）' : '—');
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
    function add(title, ids, startNo) {
      var h = document.createElement('div');
      h.className = 'grp';
      h.textContent = title;
      box.appendChild(h);
      ids.forEach(function (id, i) {
        var st = M.byId[id];
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-st', id);
        var no = document.createElement('span');
        no.className = 'no';
        no.textContent = startNo ? ('01|' + String(i + 1).padStart(2, '0')) : ('01|Y' + (i + 1));
        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = st.zh;
        b.appendChild(no); b.appendChild(nm);
        if (st.tr.length) { var t = document.createElement('span'); t.className = 'tag'; t.textContent = '换乘'; b.appendChild(t); }
        if (st.term) { var t2 = document.createElement('span'); t2.className = 'tag'; t2.textContent = '端点'; b.appendChild(t2); }
        b.addEventListener('click', function () { setTarget(id); updateStationList(); });
        box.appendChild(b);
      });
    }
    add('主线（韦家碾 → 科学城）', M.trunk.slice(0, -1).concat(M.mainTail.slice(1)), true);
    add('支线（四河 → 五根松）', M.eastTail.slice(1), false);
    $('stCount').textContent = '共 ' + M.stations.length + ' 站';
    updateStationList();
  }

  function updateStationList() {
    var btns = $('stlist').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var id = btns[i].getAttribute('data-st');
      btns[i].classList.toggle('here', id === state.curId);
      btns[i].classList.toggle('target', id === state.target);
    }
  }

  function updateStationInfo() {
    var id = selected;
    if (!id) {
      $('stName').textContent = '—'; $('stForm').textContent = '—';
      $('stTr').textContent = '—'; $('stKm').textContent = '—';
      $('btnGoStation').disabled = true;
      return;
    }
    var st = M.byId[id];
    $('stName').textContent = st.zh + '（' + st.en + '）';
    $('stForm').textContent = st.form;
    var tr = st.tr.length ? (st.tr.join('、') + ' 号线') : '无';
    if (st.planned.length) tr += '（在建：' + st.planned.join('、') + '）';
    $('stTr').textContent = tr;
    $('stKm').textContent = stationKm(id).toFixed(2) + ' km（自韦家碾）';
    $('btnGoStation').disabled = false;
    labelEls.forEach(function (L) { L.g.classList.toggle('hot', L.st.id === id); });
  }

  function updateScaleBar() {
    /* 1 km 对应多少屏幕 px（按线路平均比例尺估算） */
    var pxPerKm = view.k * (ROUTES.main.mapAt[ROUTES.main.mapAt.length - 1] - ROUTES.main.mapAt[0]) / ROUTES.main.kmLength;
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
    buildTrain();
    buildStationList();
    resetState(false);
    bindControls();
    resize();
    fitView();
    /* 调试/截图用参数：?adv=秒数 预跑运行模拟, ?follow=1 跟随, ?k=缩放, ?door=1 开门状态 */
    debugParams();
    updateHud();
    updateStationInfo();
    applyView();
    ready = true;
    var last = 0, hudAcc = 0;
    function frame(t) {
      requestAnimationFrame(frame);
      var dtRaw = last ? Math.min(0.12, (t - last) / 1000) : 0;   // 切后台回来不跳变
      last = t;
      if (!ready) return;
      var dt = dtRaw * (state.paused ? 0 : state.mult);
      var guard = 0;
      while (dt > 1e-6 && guard++ < 12) {         // 大 dt 时拆分子步保证物理稳定
        var sub = Math.min(dt, 0.04);
        stepTrain(state, sub);
        dt -= sub;
      }
      renderTrain();
      followStep(dtRaw);
      hudAcc += dtRaw;
      if (hudAcc > 0.12) { hudAcc = 0; updateHud(); }
    }
    requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', function () { last = 0; });
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });
  }

  function resize() {
    var r = $('stage').getBoundingClientRect();
    stage.w = Math.max(200, r.width);
    stage.h = Math.max(200, r.height);
    var m = $('map');
    m.setAttribute('viewBox', '0 0 ' + f1(stage.w) + ' ' + f1(stage.h));
    if (view.fitted) fitView(); else { clampView(); applyView(); updateLabelScale(); }
    updateScaleBar();
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
    if (map.route && ROUTES[map.route]) {
      state.routeKey = map.route;
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
  }

  function bindControls() {
    $('btnPlay').addEventListener('click', function () {
      state.paused = !state.paused;
      this.textContent = state.paused ? '▶︎ 继续' : '⏸ 暂停';
      updateHud();
    });
    $('btnReset').addEventListener('click', function () {
      resetState(false);
      setFollow(false);
      view.fitted = true;
      fitView();
      updateStationList();
      updateStationInfo();
      updateHud();
      toast('已复位到起点站：韦家碾');
    });
    $('btnClearTarget').addEventListener('click', function () {
      setTarget(null);
      updateStationList();
      toast('已清除目标站');
    });
    $('btnGoStation').addEventListener('click', function () {
      if (selected) { setTarget(selected); updateStationList(); }
    });
    $('segSpeed').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.mult = Number(b.getAttribute('data-mult'));
      var all = this.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      recomputeEta();
      updateHud();
    });
    $('chkFollow').addEventListener('change', function () { setFollow(this.checked); });
    $('selRoute').addEventListener('change', function () {
      var key = this.value;
      if (key === state.routeKey) return;
      state.routeKey = key;
      state.posKm = stationKm(state.curId);
      var r = ROUTES[key], i = r.ids.indexOf(state.curId);
      if (i < 0) { state.curId = r.ids[0]; state.posKm = 0; i = 0; state.dir = 1; }
      state.phase = 'dwell'; state.phaseT = 0; state.door = 0; state.doorPhase = 'closed';
      state.nextIdx = clamp(i + state.dir, 0, r.ids.length - 1);
      recomputeEta();
      updateHud();
      toast('交路切换为：' + r.label);
    });

    var map = $('map');
    map.addEventListener('pointerdown', onPointerDown);
    map.addEventListener('pointermove', onPointerMove);
    map.addEventListener('pointerup', onPointerUp);
    map.addEventListener('pointercancel', onPointerUp);
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
    var expectMain = ['韦家碾', '升仙湖', '火车北站', '人民北路', '文殊院', '骡马市', '天府广场', '锦江宾馆', '华西坝',
      '省体育馆', '倪家桥', '桐梓林', '火车南站', '高新', '金融城', '孵化园', '锦城广场', '世纪城', '天府三街',
      '天府五街', '华府大道', '四河', '华阳', '海昌路', '广福', '红石公园', '麓湖', '武汉路', '天府公园', '西博城',
      '广州路', '兴隆湖', '科学城'];
    var gotMain = ROUTES.main.ids.map(function (id) { return M.byId[id].zh; });
    chk('站点总数 = 35', M.stations.length === 35, M.stations.length);
    chk('站名无重复', new Set(names).size === names.length);
    chk('主线顺序 = 官方列表（韦家碾→科学城）', gotMain.join(',') === expectMain.join(','), gotMain.length);
    var expectBranch = gotMain.slice(0, 22).concat(['广都', '五根松']);
    chk('支线顺序 = 韦家碾…四河,广都,五根松',
      ROUTES.branch.ids.map(function (id) { return M.byId[id].zh; }).join(',') === expectBranch.join(','));
    chk('里程合计 ≈ 41 km', Math.abs(ROUTES.main.kmLength +
      (ROUTES.branch.kmLength - ROUTES.branch.kmAt[ROUTES.branch.ids.indexOf(M.junctionId)]) - 41) < 0.01,
      f2(ROUTES.main.kmLength + ROUTES.branch.kmLength - ROUTES.branch.kmAt[ROUTES.branch.ids.indexOf(M.junctionId)]));

    /* 站点位置必须落在路径上、里程单调 */
    var onLine = true, mono = true;
    ['main', 'branch'].forEach(function (key) {
      var r = ROUTES[key];
      r.ids.forEach(function (id, i) {
        var p = pointAt(r, r.mapAt[i]);
        if (Math.hypot(p.x - M.byId[id].x, p.y - M.byId[id].y) > 1e-6) onLine = false;
        if (i && r.kmAt[i] <= r.kmAt[i - 1]) mono = false;
      });
    });
    chk('全部站点均落在路径上（误差 < 1e-6）', onLine);
    chk('站点里程单调递增', mono);
    chk('端点在路径两端（含折返线延长段）',
      ROUTES.main.mapAt[0] > 40 && ROUTES.main.mapAt[ROUTES.main.mapAt.length - 1] < ROUTES.main.length - 40);

    /* 列车几何：车体轮廓顶点到路径的距离应等于设计半宽 */
    var maxErr = 0;
    (function () {
      var route = ROUTES.main, s = route.mapAt[10];
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

    /* 全程运行：不超速、逐站停靠、终点折返 */
    var sim = cloneState();
    sim.phase = 'dwell'; sim.phaseT = 0;
    var t = 0, stops = [], vmaxSeen = 0, reversed = false, dir0 = sim.dir;
    while (t < 20000) {
      stepTrain(sim, 0.25); t += 0.25;
      vmaxSeen = Math.max(vmaxSeen, sim.v);
      if (sim.phase === 'dwell' && sim.phaseT < 0.3 && stops[stops.length - 1] !== sim.curId) stops.push(sim.curId);
      if (sim.dir !== dir0) { reversed = true; break; }
    }
    chk('全程依次停靠 33 站（主线）', stops.length === 33 && stops[32] === 'kexuecheng', stops.length + ' 站，末站 ' + (stops[32] || '-'));
    chk('不超过区间限速 60 km/h', vmaxSeen <= CFG.vmax + 1e-6, f2(vmaxSeen));
    chk('到达终点后折返换向', reversed, '折返后方向 ' + sim.dir + '，当前站 ' + (sim.curId ? M.byId[sim.curId].zh : '-'));
    chk('仿真时长合理（< 90 分钟）', t < 5400, f2(t / 60) + ' 分钟');

    /* 目标站导航：支线站点（需在四河切换交路） */
    var sim2 = cloneState();
    sim2.target = 'wugensong';
    var t2 = 0, hits = 0;
    while (t2 < 20000 && hits < 1) {
      stepTrain(sim2, 0.25); t2 += 0.25;
      if (sim2.curId === 'wugensong' && sim2.phase === 'dwell') hits++;
      if (sim2.phase === 'reverse') rev2 = true;
    }
    var rev2 = false;
    chk('点击支线站（五根松）可到达并在四河换交路', hits === 1, '耗时 ' + fmtDur(t2) + '，交路 ' + sim2.routeKey);

    /* 后方站点：需要折返 */
    var sim3 = cloneState();
    sim3.routeKey = 'main'; sim3.dir = 1; sim3.posKm = stationKm('huochenanzhan');
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

    chk('渲染元素齐备（35 车站 / 35 标签 / 3 车厢）',
      Object.keys(stationEls).length === 35 && labelEls.length === 35 && trainEls.length === 3);

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
    pe('pointerdown', sp.x, sp.y, 11); pe('pointerup', sp.x, sp.y, 11);
    setTimeout(function () {
      chk('单击站点 → 设为目标站', state.target === 'xibocheng', String(state.target));
      setTarget(null);
      zoomAt(stage.w / 2, stage.h / 2, 3 / view.k);      // 先放大，否则全景下平移本就被约束
      var tx0 = view.tx, ty0 = view.ty;
      pe('pointerdown', sp.x, sp.y, 12);
      pe('pointermove', sp.x + 40, sp.y + 55, 12);
      pe('pointermove', sp.x + 75, sp.y + 95, 12);
      pe('pointerup', sp.x + 75, sp.y + 95, 12);
      setTimeout(function () {
        chk('单指拖动 → 平移且不误触发站点点击',
          Math.abs(view.tx - tx0) > 30 && state.target === null,
          'dx=' + f2(view.tx - tx0) + ', target=' + String(state.target));
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
          /* 长按（超时）不应选站 */
          var st2 = M.byId.huochenanzhan;
          var sp2 = { x: st2.x * view.k + view.tx, y: st2.y * view.k + view.ty };
          setTarget(null);
          pe('pointerdown', sp2.x, sp2.y, 41);
          setTimeout(function () {
            pe('pointerup', sp2.x, sp2.y, 41);
            setTimeout(function () {
              chk('长按（>800ms）不触发选站', state.target === null, 'target=' + String(state.target));
              pe('pointerdown', sp2.x, sp2.y, 42); pe('pointerup', sp2.x, sp2.y, 42);
              setTimeout(function () {
                chk('轻点可选中（长按后恢复正常）', state.target === 'huochenanzhan', String(state.target));
                setTarget(null);
                done();
              }, 320);
            }, 30);
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
    stationKm: stationKm, stationMapS: stationMapS, panBox: panBox, contentBox: contentBox, stage: stage
  };
})();
