/* =============================================================================
 * data.js - 成都地铁 1 号线 站点数据 + 示意几何
 * -----------------------------------------------------------------------------
 * 站点名称 / 顺序 / 车站形式 / 可换乘线路：
 *   来源：百度百科《成都地铁1号线》词条（wapbaike.baidu.com，抓取日期 2026-09-12）
 *         词条内表格“沿线站点”标注“据2026年5月成都地铁官网信息”。
 *   换乘线路只收录“已开通”的线路；规划/在建线路放在 planned 字段。
 *
 * 经纬度（lat/lon）：示意坐标，手写近似值，仅用于渲染成图，不是实测测绘数据。
 *   说明见 README“数据来源”一节。
 * ========================================================================== */
window.METRO = (function () {
  'use strict';

  /* 线路标识色：官方描述为“蓝色（CMYK 97,100,31,0）”，未给出权威十六进制，
     此处取近似值，README 中已标注“待核实”。 */
  var LINE_COLOR = '#0d6cb5';

  var S = [
    // ---- 主线：韦家碾 -> 科学城 (33 站) ----
    { id: 'weijianian',    zh: '韦家碾',   en: 'Weijianian',                 form: '地下侧式',     tr: ['27'],    plan: ['S11'], lat: 30.7275, lon: 104.0720, term: true },
    { id: 'shengxianhu',   zh: '升仙湖',   en: 'Shengxian Lake',             form: '地下岛式',     tr: [],        plan: [],      lat: 30.7170, lon: 104.0785 },
    { id: 'huochebeizhan', zh: '火车北站', en: 'North Railway Station',      form: '地下岛式',     tr: ['7'],     plan: ['18'],  lat: 30.7050, lon: 104.0750 },
    { id: 'renminbeilu',   zh: '人民北路', en: 'Renmin North Road',          form: '地下岛式',     tr: ['6'],     plan: [],      lat: 30.6930, lon: 104.0720 },
    { id: 'wenshuyuan',    zh: '文殊院',   en: 'Wenshu Monastery',           form: '地下岛式',     tr: [],        plan: [],      lat: 30.6780, lon: 104.0700 },
    { id: 'luomashi',      zh: '骡马市',   en: 'Luomashi',                   form: '地下岛式',     tr: ['4'],     plan: ['10', '18'], lat: 30.6670, lon: 104.0700 },
    { id: 'tianfuguangchang', zh: '天府广场', en: 'Tianfu Square',           form: '地下西班牙式', tr: ['2'],     plan: [],      lat: 30.6570, lon: 104.0680 },
    { id: 'jinjiangbinguan', zh: '锦江宾馆', en: 'Jinjiang Hotel',           form: '地下岛式',     tr: [],        plan: [],      lat: 30.6490, lon: 104.0680 },
    { id: 'huaxiba',       zh: '华西坝',   en: 'Huaxiba',                    form: '地下岛式',     tr: ['13'],    plan: [],      lat: 30.6410, lon: 104.0665 },
    { id: 'shengtiyuguan', zh: '省体育馆', en: 'Sichuan Gymnasium',          form: '地下岛式',     tr: ['3'],     plan: ['18'],  lat: 30.6330, lon: 104.0660 },
    { id: 'nijiaqiao',     zh: '倪家桥',   en: 'Nijiaqiao',                  form: '地下岛式',     tr: ['8'],     plan: ['18'],  lat: 30.6250, lon: 104.0660 },
    { id: 'tongzilin',     zh: '桐梓林',   en: 'Tongzilin',                  form: '地下岛式',     tr: [],        plan: [],      lat: 30.6150, lon: 104.0655 },
    { id: 'huochenanzhan', zh: '火车南站', en: 'South Railway Station',      form: '地下岛式',     tr: ['7', '18'], plan: [],     lat: 30.6060, lon: 104.0645 },
    { id: 'gaoxin',        zh: '高新',     en: 'Hi-Tech Zone',               form: '地下侧式',     tr: [],        plan: [],      lat: 30.5900, lon: 104.0640 },
    { id: 'jinrongcheng',  zh: '金融城',   en: 'Financial City',             form: '地下岛式',     tr: [],        plan: [],      lat: 30.5800, lon: 104.0645 },
    { id: 'fuhuayuan',     zh: '孵化园',   en: 'Incubation Park',            form: '地下岛式',     tr: ['9', '18'], plan: [],     lat: 30.5720, lon: 104.0650 },
    { id: 'jinchengplaza', zh: '锦城广场', en: 'Jincheng Plaza',             form: '地下岛式',     tr: [],        plan: [],      lat: 30.5650, lon: 104.0660 },
    { id: 'shijicheng',    zh: '世纪城',   en: 'Century City',               form: '地下岛式',     tr: ['18'],    plan: [],      lat: 30.5570, lon: 104.0670 },
    { id: 'tianfusanjie',  zh: '天府三街', en: '3rd Tianfu Street',          form: '地下岛式',     tr: [],        plan: [],      lat: 30.5480, lon: 104.0680 },
    { id: 'tianfuwujie',   zh: '天府五街', en: '5th Tianfu Street',          form: '地下岛式',     tr: [],        plan: [],      lat: 30.5400, lon: 104.0690 },
    { id: 'huafudadao',    zh: '华府大道', en: 'Huafu Avenue',               form: '地下岛式',     tr: [],        plan: [],      lat: 30.5250, lon: 104.0700 },
    { id: 'sihe',          zh: '四河',     en: 'Sihe',                       form: '地下双岛式',   tr: [],        plan: ['15'],  lat: 30.5120, lon: 104.0715, junction: true },
    { id: 'huayang',       zh: '华阳',     en: 'Huayang',                    form: '地下岛式',     tr: [],        plan: [],      lat: 30.5000, lon: 104.0730 },
    { id: 'haichanglu',    zh: '海昌路',   en: 'Haichang Road',              form: '地下岛式',     tr: ['18'],    plan: [],      lat: 30.4900, lon: 104.0740 },
    { id: 'guangfu',       zh: '广福',     en: 'Guangfu',                    form: '地下岛式',     tr: [],        plan: [],      lat: 30.4800, lon: 104.0750 },
    { id: 'hongshigongyuan', zh: '红石公园', en: 'Hongshi Park',             form: '地下岛式',     tr: [],        plan: [],      lat: 30.4680, lon: 104.0765 },
    { id: 'luhu',          zh: '麓湖',     en: 'Luhu Lake',                  form: '地下岛式',     tr: [],        plan: [],      lat: 30.4580, lon: 104.0780 },
    { id: 'wuhanlu',       zh: '武汉路',   en: 'Wuhan Road',                 form: '地下岛式',     tr: [],        plan: [],      lat: 30.4470, lon: 104.0790 },
    { id: 'tianfugongyuan', zh: '天府公园', en: 'Tianfu Park',               form: '地下岛式',     tr: [],        plan: [],      lat: 30.4370, lon: 104.0800 },
    { id: 'xibocheng',     zh: '西博城',   en: "Western China Int'l Expo City", form: '地下岛式',  tr: ['6', '18'], plan: [],     lat: 30.4270, lon: 104.0810 },
    { id: 'guangzhoulu',   zh: '广州路',   en: 'Guangzhou Road',             form: '地下岛式',     tr: [],        plan: [],      lat: 30.4170, lon: 104.0820 },
    { id: 'xinglonghu',    zh: '兴隆湖',   en: 'Xinglong Lake',              form: '地下岛式',     tr: [],        plan: [],      lat: 30.4060, lon: 104.0830 },
    { id: 'kexuecheng',    zh: '科学城',   en: 'Science City',               form: '地下侧式',     tr: [],        plan: [],      lat: 30.3950, lon: 104.0840, term: true },

    // ---- 支线：四河 -> 五根松 (2 站) ----
    { id: 'guangdu',       zh: '广都',     en: 'Guangdu',                    form: '地下岛式',     tr: [],        plan: [],      lat: 30.5055, lon: 104.0775, branch: true },
    { id: 'wugensong',     zh: '五根松',   en: 'Wugensong',                  form: '地下岛式',     tr: [],        plan: [],      lat: 30.4985, lon: 104.0855, branch: true, term: true }
  ];

  /* 线路走向：按真实大致南北走向排列（见 README）。 */
  var TRUNK = ['weijianian', 'shengxianhu', 'huochebeizhan', 'renminbeilu', 'wenshuyuan', 'luomashi',
    'tianfuguangchang', 'jinjiangbinguan', 'huaxiba', 'shengtiyuguan', 'nijiaqiao', 'tongzilin',
    'huochenanzhan', 'gaoxin', 'jinrongcheng', 'fuhuayuan', 'jinchengplaza', 'shijicheng',
    'tianfusanjie', 'tianfuwujie', 'huafudadao', 'sihe'];

  var MAIN_TAIL = ['sihe', 'huayang', 'haichanglu', 'guangfu', 'hongshigongyuan', 'luhu', 'wuhanlu',
    'tianfugongyuan', 'xibocheng', 'guangzhoulu', 'xinglonghu', 'kexuecheng'];

  var EAST_TAIL = ['sihe', 'guangdu', 'wugensong'];

  /* 投影：等距圆柱近似 + 水平方向放大（示意地图常用做法，便于看清南北走向的弯折）。
     比例尺 SCALE_LON / SCALE_LAT 只影响观感，真实里程由 41 km 总长等比换算。 */
  var PROJ = { scaleLon: 12000, scaleLat: 5000, originLon: 104.0580, originLat: 30.7400, offX: 200, offY: 130 };

  function project(lat, lon) {
    return {
      x: PROJ.offX + (lon - PROJ.originLon) * PROJ.scaleLon,
      y: PROJ.offY + (PROJ.originLat - lat) * PROJ.scaleLat
    };
  }

  var byId = {};
  S.forEach(function (st) {
    st.x = project(st.lat, st.lon).x;
    st.y = project(st.lat, st.lon).y;
    st.transfers = st.tr || [];
    st.planned = st.plan || [];
    byId[st.id] = st;
  });

  /* 官方公布：线路全长 41 km，共 35 座车站（含支线）。 */
  var LINE_LENGTH_KM = 41;

  return {
    lineColor: LINE_COLOR,
    lineName: '成都地铁 1 号线',
    lineLengthKm: LINE_LENGTH_KM,
    stations: S,
    byId: byId,
    trunk: TRUNK,
    mainTail: MAIN_TAIL,
    eastTail: EAST_TAIL,
    junctionId: 'sihe',
    project: project,
    mapW: 980,
    mapH: 2000,
    /* 站点总数自检 */
    totalStations: S.length
  };
})();
