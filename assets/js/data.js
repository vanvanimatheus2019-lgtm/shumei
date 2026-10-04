/* 毛乌素四十年：数据与展示内容。
 * 遥感序列沿用提供的工程；本次检查数值计算与展示口径，没有重跑 GEE 原始处理。
 * A：已有逐年遥感估算数组；B：旧工程锚点/插值示意，不能当作逐年实测。
 * 官方报道、遥感估算和示意数列分别标记，不相互替代。
 */
/* ---------- 年份轴 ---------- */
/* 保留工程随附的 1986—2025 序列；不据此断言其他年份全国均无可用影像。 */
const YEAR_START = 1986;
const YEAR_END = 2025;
const YEARS = [];
for (let y = YEAR_START; y <= YEAR_END; y++) YEARS.push(y);

/* ---------- 确定性伪随机（保证每次刷新画面一致） ---------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一维平滑值噪声，返回 [-1, 1] */
function smoothNoise1D(seed) {
  const rnd = mulberry32(seed);
  const N = 256, table = new Float32Array(N);
  for (let i = 0; i < N; i++) table[i] = rnd() * 2 - 1;
  return function (x) {
    const i0 = Math.floor(x), f = x - i0;
    const a = table[((i0 % N) + N) % N];
    const b = table[(((i0 + 1) % N) + N) % N];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

/* ---------- 锚点插值 ---------- */
/** Catmull-Rom 插值（端点钳制），anchors = [[year, value], ...] */
function interpolate(anchors, noiseSeed, noiseAmp) {
  const pts = anchors.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const noise = noiseAmp ? smoothNoise1D(noiseSeed || 1) : null;

  return YEARS.map((y) => {
    let v;
    if (y <= pts[0][0]) v = pts[0][1];
    else if (y >= pts[n - 1][0]) v = pts[n - 1][1];
    else {
      let k = 0;
      while (k < n - 2 && y > pts[k + 1][0]) k++;
      const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(n - 1, k + 2)];
      const t = (y - p1[0]) / (p2[0] - p1[0]);
      const t2 = t * t, t3 = t2 * t;
      v = 0.5 * (
        2 * p1[1] +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
      );
    }
    if (noise) v += noise(y * 0.7) * noiseAmp;
    return +v.toFixed(3);
  });
}

/* ==========================================================================
 * 一、毛乌素沙地 时序序列
 * ========================================================================== */

const MU_US = {
  /* 生长季 NDVI（归一化植被指数） */
  ndvi: {
    label: '生长季 NDVI', unit: '', decimals: 3, grade: 'A',
    source: 'Google Earth Engine · Landsat 4/5/7/8/9 C2 L2 SR，生长季 6—9 月，500 m 统计网格，全区公共支撑掩膜（validFrac 0.988—1.000）',
    caveat: '工程随附的生长季合成序列，采用三年滑窗。未提供完整原始导出与跨传感器校准记录；变化同时可能包含传感器和处理影响，结论采用五年窗口。',
    /* GEE-BEGIN:ndvi */
    anchors: [[1986, 0.169], [1987, 0.174], [1988, 0.170], [1989, 0.181], [1990, 0.172],
              [1991, 0.172], [1992, 0.163], [1993, 0.167], [1994, 0.161], [1995, 0.181],
              [1996, 0.171], [1997, 0.179], [1998, 0.168], [1999, 0.169], [2000, 0.159],
              [2001, 0.182], [2002, 0.199], [2003, 0.217], [2004, 0.194], [2005, 0.193],
              [2006, 0.207], [2007, 0.219], [2008, 0.218], [2009, 0.226], [2010, 0.234],
              [2011, 0.251], [2012, 0.266], [2013, 0.299], [2014, 0.288], [2015, 0.294],
              [2016, 0.295], [2017, 0.321], [2018, 0.311], [2019, 0.309], [2020, 0.298],
              [2021, 0.310], [2022, 0.329], [2023, 0.342], [2024, 0.348], [2025, 0.349]],
    /* GEE-END:ndvi */
    noiseAmp: 0, seed: 11,
  },
  /* 植被覆盖度 %（像元二分模型 FVC） */
  cover: {
    label: '研究矩形覆盖度估算', unit: '%', decimals: 1, grade: 'A',
    source: '同源 Landsat：像元二分模型 FVC = (NDVI − NDVIsoil) / (NDVIveg − NDVIsoil)，逐像元计算后取区域均值；端元为工程给定的分位值 NDVIsoil=0.0918(p5, 1986—1990)、NDVIveg=0.5137(p95, 2018—2025)',
    caveat: '区域统计口径，与行政统计的「植被覆盖度」不完全可比；NDVIveg 取 p95 意味着把最密 5% 像元视为满覆盖，若真实满冠 NDVI 更高，本序列偏乐观',
    /* GEE-BEGIN:cover */
    anchors: [[1986, 18.5], [1987, 19.5], [1988, 18.7], [1989, 21.4], [1990, 19.0],
              [1991, 19.0], [1992, 16.9], [1993, 17.9], [1994, 16.5], [1995, 21.2],
              [1996, 18.9], [1997, 20.7], [1998, 18.2], [1999, 18.4], [2000, 16.0],
              [2001, 21.6], [2002, 25.4], [2003, 29.7], [2004, 24.3], [2005, 24.0],
              [2006, 27.3], [2007, 30.2], [2008, 29.9], [2009, 31.9], [2010, 33.7],
              [2011, 37.7], [2012, 41.3], [2013, 48.9], [2014, 46.3], [2015, 47.7],
              [2016, 48.0], [2017, 53.9], [2018, 51.7], [2019, 51.0], [2020, 48.5],
              [2021, 51.3], [2022, 55.4], [2023, 58.3], [2024, 59.5], [2025, 59.7]],
    /* GEE-END:cover */
    noiseAmp: 0, seed: 23,
  },
  /* 基期低植被子集，不等同官方沙地边界。 */
  ndviCore: {
    label: '基期低植被区 NDVI', unit: '', decimals: 3, grade: 'A',
    source: '工程定义的基期低植被子集：1986—1990 年 NDVI < 0.15，约占研究矩形 31.7%',
    caveat: '低 NDVI 阈值并非土地分类。该子集可能包含其他低植被地表，不能据此声称排除了农田或识别出真实沙地边界。',
    anchors: [[1986, 0.117], [1987, 0.118], [1988, 0.117], [1989, 0.121], [1990, 0.120],
              [1991, 0.122], [1992, 0.121], [1993, 0.123], [1994, 0.124], [1995, 0.129],
              [1996, 0.129], [1997, 0.131], [1998, 0.131], [1999, 0.130], [2000, 0.125],
              [2001, 0.132], [2002, 0.140], [2003, 0.152], [2004, 0.149], [2005, 0.148],
              [2006, 0.158], [2007, 0.163], [2008, 0.164], [2009, 0.172], [2010, 0.179],
              [2011, 0.190], [2012, 0.199], [2013, 0.225], [2014, 0.224], [2015, 0.231],
              [2016, 0.236], [2017, 0.250], [2018, 0.246], [2019, 0.247], [2020, 0.246],
              [2021, 0.257], [2022, 0.269], [2023, 0.279], [2024, 0.286], [2025, 0.290]],
    noiseAmp: 0, seed: 31,
  },
  coverCore: {
    label: '基期低植被区覆盖度估算', unit: '%', decimals: 1, grade: 'A',
    source: '同 cover 的像元二分模型，统计范围为固定的基期低植被子集',
    
    caveat: '同一基期低植被子集的五年窗口覆盖度估算增加；该结果不能替代沙化土地分类，也不能单独证明治理因果。',
    anchors: [[1986, 6.3], [1987, 6.5], [1988, 6.4], [1989, 7.3], [1990, 7.1],
              [1991, 7.5], [1992, 7.1], [1993, 7.7], [1994, 7.8], [1995, 9.2],
              [1996, 9.2], [1997, 9.6], [1998, 9.4], [1999, 9.3], [2000, 8.3],
              [2001, 9.8], [2002, 11.7], [2003, 14.4], [2004, 13.7], [2005, 13.5],
              [2006, 15.8], [2007, 17.0], [2008, 17.2], [2009, 19.1], [2010, 20.7],
              [2011, 23.4], [2012, 25.6], [2013, 31.6], [2014, 31.4], [2015, 33.0],
              [2016, 34.1], [2017, 37.4], [2018, 36.6], [2019, 36.7], [2020, 36.5],
              [2021, 38.9], [2022, 41.9], [2023, 44.2], [2024, 45.7], [2025, 46.6]],
    noiseAmp: 0, seed: 37,
  },
  /* 累计治理沙化土地面积（万亩） */
  treated: {
    label: '治理面积趋势示意', unit: '万亩', decimals: 0, grade: 'B',
    source: '旧工程随附锚点，未附可逐项核对的原始统计表；中间年份为插值',
    anchors: [[1984, 180], [1990, 520], [1995, 900], [2000, 1450], [2005, 2200],
              [2010, 3050], [2015, 4000], [2020, 5000], [2025, 5640]],
    noiseAmp: 0, seed: 31,
  },
  /* 年沙尘天气日数（天） */
  dust: {
    label: '沙尘日数趋势示意', unit: '天', decimals: 0, grade: 'B',
    source: '旧工程随附锚点，尚未接入气象站逐年观测；中间年份为插值',
    anchors: [[1984, 46], [1990, 38], [1995, 31], [2000, 28], [2005, 20],
              [2010, 15], [2015, 11], [2020, 9], [2025, 7]],
    noiseAmp: 0, seed: 53,
  },
  /* 保留旧工程泥沙数列供审查，未提供逐年公报表格，不作为治理结论。 */
  sediment: {
    label: '潼关输沙量趋势示意', unit: '亿吨', decimals: 2, grade: 'B',
    source: '旧工程随附数列；逐年公报页码及表格未随包提供，本次未验证原始测值',
    caveat: '不能作为毛乌素治理独立效果的证据，流域输沙量还受降水、水库等因素影响。',
    anchors: [[1984, 11.2], [1990, 10.4], [1995, 8.1], [2000, 3.9], [2005, 3.0],
              [2010, 2.2], [2015, 1.4], [2020, 2.6],
              [2021, 1.71], [2022, 2.03], [2023, 0.90], [2024, 1.83], [2025, 2.58]],
    noiseAmp: 0, seed: 59,
    window: { lo: 2021, hi: 2025, mean: null, prev: '2000—2020', prevMean: null,
              base: '1956—2016', baseMean: null },
    note: '这条曲线保留旧工程的锚点和插值，仅供查看趋势构图。逐年公报表格尚未核对，不显示实测标记，不引用窗口均值或降幅。',
  },
  /* 旧工程地下水锚点（米），仅供趋势示意。 */
  groundwater: {
    label: '地下水位趋势示意', unit: 'm', decimals: 2, grade: 'B',
    source: '旧工程随附锚点，未附井号、观测时间及原始记录；中间年份为插值',
    anchors: [[1984, 0], [1995, 0.55], [2005, 1.20], [2015, 1.85], [2025, 2.30]],
    noiseAmp: 0, seed: 67,
  },
};


/* 面积为公开文献中的概述值，研究矩形并非该面积的边界。 */
const AREA = {
  totalKm2: 42200, totalMu: 6330, grade: 'A',
  source: '《中国农学通报》2006，刘翠英《毛乌素沙地城镇绿化可利用的野生观赏植物资源》',
  url: 'https://www.casb.org.cn/CN/abstract/abstract2224.shtml',
};
const MU_SERIES = {};
Object.keys(MU_US).forEach((k) => {
  const s = MU_US[k];
  s.values = interpolate(s.anchors, s.seed, s.noiseAmp);
  s.status = s.grade === 'A' ? '遥感估算' : '趋势示意';
  s.verified = false; // 本次没有复核 GEE 原始导出，或逐年统计来源。
  MU_SERIES[k] = s.values;
});
MU_SERIES.groundwater = MU_SERIES.groundwater.map((v) => Math.max(0, v));
MU_US.groundwater.values = MU_SERIES.groundwater;

const WIN = { lo: [1987, 1991], hi: [2020, 2024] };
function winMean(ser, lo, hi) {
  if (!Array.isArray(ser) || lo < YEAR_START || hi > YEAR_END || lo > hi) return null;
  let sum = 0;
  for (let y = lo; y <= hi; y++) {
    const v = ser[y - YEAR_START];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / (hi - lo + 1);
}
const HEADLINE = {
  win: WIN,
  ndvi: [winMean(MU_SERIES.ndvi, ...WIN.lo), winMean(MU_SERIES.ndvi, ...WIN.hi)],
  fvc: [winMean(MU_SERIES.cover, ...WIN.lo), winMean(MU_SERIES.cover, ...WIN.hi)],
  fvcCore: [winMean(MU_SERIES.coverCore, ...WIN.lo), winMean(MU_SERIES.coverCore, ...WIN.hi)],
  sedWin: null,
};

/* 四十年变化摘要：由 tools/make_change_map.py 从四十张年度 PNG 计算。
 * tests/change.test.cjs 检查这里的数与 assets/data/change/change-stats.json 一致。 */
const CHANGE = {
  windows: { lo: [1987, 1991], hi: [2020, 2024] },
  regionMean: [0.173, 0.325],
  shareRise005: 0.8756, shareRise010: 0.6942, shareRise020: 0.2913, shareFall010: 0.0009,
  coreShare: 0.3258, coreRise010: 0.7119,
  stats: 'assets/data/change/change-stats.json',
};
/* 区域 NDVI 的三段直线拟合（同一脚本输出）。只描述曲线形状，不代表原因。 */
const PHASES = [
  { start: 1986, end: 2000, name: '平稳期', slope: -0.0004 },
  { start: 2001, end: 2011, name: '上升期', slope: 0.0053 },
  { start: 2012, end: 2025, name: '高位继续上升', slope: 0.0052 },
];
/* 缺少上游记录的数字不作为已验证事实发布。原值在核查文档中保留。 */
const FACTS_NUM = {
  groundwaterRise: null, dustFrom: null, dustTo: null,
  sedBaseline2000s: null, sedLongTermMean: null, sedYear2025: null,
  modisGrowth: null, modisR: null,
};
MU_SERIES.treatedRate = MU_SERIES.treated.map((v) => +(v / AREA.totalMu * 100).toFixed(1));
MU_US.treatedRate = {
  label: '治理面积比例示意', unit: '%', decimals: 1, grade: 'B', status: '趋势示意', verified: false,
  source: '旧锚点治理面积 / 文献概述面积；分子与分母口径未核齐，不能称为行政治理率',
  caveat: '仅保留旧工程曲线构图，不用于结论。', values: MU_SERIES.treatedRate,
};
const STATIC = {
  precip: {
    label: '降水背景', range: [340, 400], extreme: [159.6, 689.4], grade: 'B',
    source: '旧工程随附的不同站点摘要，原始站点资料及统计时段待补',
    note: '不同地点和年份的降水存在差异。本站未接入逐年降水数据，不据此判断某年旱涝，也不将植被增长全部归因于治理。',
  },
};

/* 可选外部案例：指标不同，不计算综合退化率，不代表全球总体趋势。 */
const GLOBAL = {
  aral: {
    label: '咸海水域变化示意', unit: '万 km²', decimals: 2, grade: 'B', status: '趋势示意',
    source: '旧工程的稀疏锚点，尚未附统一水体边界及逐年数据；插值仅作示意',
    anchors: [[1984, 3.60], [1990, 3.20], [1995, 2.70], [2000, 2.30], [2005, 1.70], [2010, 1.10], [2015, 0.82], [2020, 0.71], [2025, 0.66]],
    noiseAmp: 0, seed: 71,
  },
  amazon: {
    label: '森林损失示意', unit: '万 km²', decimals: 1, grade: 'B', status: '趋势示意',
    source: '旧工程的稀疏锚点，尚未附 PRODES 原表及统计边界；插值仅作示意',
    anchors: [[1984, 14.0], [1990, 24.5], [1995, 33.8], [2000, 43.2], [2005, 53.9], [2010, 62.4], [2015, 70.1], [2020, 78.3], [2025, 85.6]],
    noiseAmp: 0, seed: 79,
  },
  sahel: {
    label: '萨赫勒旧序列示意', unit: '%', decimals: 1, grade: 'B', status: '未核实示意',
    source: '旧工程的比例锚点无完整来源，不作为荒漠化事实；该地区存在降水驱动的再绿化',
    anchors: [[1984, 32.0], [1990, 33.6], [1995, 34.9], [2000, 36.1], [2005, 37.4], [2010, 38.5], [2015, 39.6], [2020, 40.5], [2025, 41.3]],
    noiseAmp: 0, seed: 83,
  },
  arctic: {
    label: '北极海冰范围示意', unit: '百万 km²', decimals: 2, grade: 'B', status: '插值示意',
    source: '2025 最小范围 4.60 由 NSIDC 2025-09-17 通报核实；其他锚点待逐年核验，整条曲线为插值示意',
    url: 'https://nsidc.org/news-analyses/news-stories/arctic-sea-ice-has-reached-minimum-extent-2025',
    anchors: [[1984, 6.90], [1990, 6.24], [1995, 6.10], [2000, 6.32], [2005, 5.57], [2010, 4.90], [2015, 4.63], [2020, 3.92], [2025, 4.60]],
    noiseAmp: 0, seed: 89,
  },
};
const GLOBAL_SERIES = {};
Object.keys(GLOBAL).forEach((k) => {
  const s = GLOBAL[k];
  s.verified = false;
  s.values = interpolate(s.anchors, s.seed, s.noiseAmp);
  GLOBAL_SERIES[k] = s.values;
});
const FACTS = [
  { num: '6.6', unit: '%', text: '中国占全球植被面积的比例', sub: '2019 年研究的背景量，不是毛乌素统计', grade: 'A', src: 'Chen 等，Nature Sustainability，2019；研究时段 2000—2017', url: 'https://escholarship.org/uc/item/5k95r370' },
  { num: '25', unit: '%', text: '中国对全球净增叶面积的贡献', sub: '包含森林与农田，不能等同于天然森林增加', grade: 'A', src: 'Chen 等，Nature Sustainability，2019；研究时段 2000—2017', url: 'https://escholarship.org/uc/item/5k95r370' },
  { num: '4.22', unit: '万 km²', text: '文献中的毛乌素沙地概述面积', sub: '跨陕西、内蒙古、宁夏；与本站研究矩形不同', grade: 'A', src: '《中国农学通报》，2006-02-05', url: AREA.url },
  { num: '93.24', unit: '%', text: '榆林市沙化土地治理率', sub: '行政统计，不能与本站覆盖度估算直接比较', grade: 'A', src: '国家林草局转载陕西省林业局，2023-09-28', url: 'https://www.forestry.gov.cn/c/www/dfdt/522132.jhtml' },
  { num: '85', unit: '%', text: '鄂尔多斯 2025 年毛乌素治理率目标', sub: '报道中的年度目标，不作为已完成治理率', grade: 'B', src: '国家林草局 / 中国绿色时报，2025-02-19', url: 'https://www.forestry.gov.cn/c/www/tpzl/610462.jhtml' },
];
const MILESTONES = [
  { year: 1978, title: '三北工程启动', text: '榆林被纳入重点建设区域。政策背景与地图观测分别呈现。', source: 'https://www.forestry.gov.cn/c/www/dfdt/522132.jhtml' },
  { year: 1984, title: '石光银承包荒沙', text: '承包 3000 多亩荒沙，筹集种苗资金，带领村民治沙。', source: 'https://www.forestry.gov.cn/c/www/dxsj/55.jhtml' },
  { year: 1986, title: '狼窝沙：树苗九成被毁', text: '石光银带 100 多人进狼窝沙造林，这年树苗 90% 被风沙毁掉，第二年又毁了 80%。本站的影像序列也从这一年开始。', source: 'https://www.forestry.gov.cn/c/www/lhgzdt/32801.jhtml' },
  { year: 1988, title: '改用障蔽治沙法', text: '在迎风坡画格子扎沙障，沙障间种沙蒿、沙柳，丘间低地种杨柳；6000 亩地搭了 800 多公里沙障，成活率约 80%。', source: 'https://www.forestry.gov.cn/c/www/lhgzdt/32801.jhtml' },
  { year: 2002, title: '防沙治沙法施行', text: '2002 年 1 月 1 日起施行，为预防、治理和保护提供法律依据。', source: 'https://www.cppcc.gov.cn/2011/10/27/ARTI1319707908609705.shtml' },
  { year: 2021, title: '经验交给下一代', text: '新华社报道石光银向孙子传授造林经验；同年获七一勋章。', source: 'https://www.forestry.gov.cn/c/www/dxsj/55.jhtml' },
  { year: 2025, title: '最近一年', text: '与 1986 年用同一套色标，可以直接比较。' },
];

const STORIES = [
  { name: '殷玉珍', place: '内蒙古乌审旗 · 萨拉乌苏村井背塘', years: '1986 年起',
    tag: '嫁到沙地，种了四十年树', quote: '',
    photo: 'assets/img/people/yinyuzhen.jpg', photoRemote: 'https://www.forestry.gov.cn/u/cms/www/202606/07070234tckk.jpg',
    photoCaption: '殷玉珍站在自己命名的“欢喜梁”上', photoCredit: '记者 李祉瑶 摄',
    photoSource: 'https://www.forestry.gov.cn/lyj/1/hmgzdt/20260607/674167.html',
    data: [{ k: '报道所述治理沙地', v: '7 万余亩' }, { k: '报道所述栽种树木', v: '800 多万棵' }],
    src: '国家林草局网站，2026-06-07《绿已盎然，等你来看》',
    url: 'https://www.forestry.gov.cn/lyj/1/hmgzdt/20260607/674167.html',
    text: '1985 年嫁到乌审旗井背塘，第二年开始在沙地里栽树。1999 年，一笔 5000 美元的捐款让她多种了 5 万多棵树；2007 年，第一条 8 公里的柏油路修到了她家门口。' },
  { name: '石光银', place: '陕西定边 · 狼窝沙', years: '1984 年起',
    tag: '三次治理狼窝沙', quote: '',
    photo: 'assets/img/people/shiguangyin.jpg', photoRemote: 'https://www.forestry.gov.cn/html/main/main_586/20210707064829670308073/20210707065305513266720.jpg',
    photoCaption: '石光银在自己最早治理的“狼窝沙”林地里（2020 年 5 月 30 日）', photoCredit: '新华社记者 刘潇 摄',
    photoSource: 'http://www.forestry.gov.cn/c/www/rwjj/5796.jhtml',
    data: [{ k: '报道所述反复造林', v: '35 万亩' }, { k: '报道所述植树（丛）', v: '5300 多万' }],
    src: '国家林草局转载新华社，2021-07-07',
    url: 'https://www.forestry.gov.cn/c/www/dxsj/55.jhtml',
    text: '1984 年办起农民股份制治沙公司，卖了 84 只羊和 1 头骡子凑钱。狼窝沙前两年树苗大多被毁，1988 年改用障蔽治沙法才保住。2021 年 6 月 29 日获“七一勋章”。' },
  { name: '牛玉琴', place: '陕西靖边', years: '1984 年起',
    tag: '丈夫留下的种树图，她扩大了近 7 倍', quote: '',
    photo: 'assets/img/people/niuyuqin.jpg', photoRemote: 'https://www.forestry.gov.cn/u/cms/www/202307/04083409z4w0.jpg',
    photoCaption: '2005 年，牛玉琴在沙漠中', photoCredit: '图片来源：国家林草局网站',
    photoSource: 'https://www.forestry.gov.cn/lyj/1/hmjyjl/20230704/513317.html',
    data: [{ k: '报道所述治沙造林', v: '11 万亩' }, { k: '报道所述植树', v: '2800 余万株' }],
    src: '国家林草局 / 陕西日报，2023-07-04',
    url: 'https://www.forestry.gov.cn/lyj/1/hmjyjl/20230704/513317.html',
    text: '1984 年和丈夫张家旺承包荒沙，1987 年一场沙暴毁了大部分树苗。丈夫去世后她接着种，把他留下的规划扩大了近 7 倍。1998 年，学林业的三儿子张立强回来做技术，把红松、樟子松嫁接到落叶松上，成活率 97%。' },
  { name: '王有德', place: '宁夏灵武 · 白芨滩', years: '1985 年起',
    tag: '把林场职工和沙地一起带出来', quote: '',
    photo: 'assets/img/people/wangyoude.jpg', photoRemote: 'https://www.forestry.gov.cn/html/main/main_6109/20210524175821466808138/20210524180044012719173.png',
    photoCaption: '王有德', photoCredit: '图片来源：国家林草局网站',
    photoSource: 'https://www.forestry.gov.cn/c/www/lcxjdx/150782.jhtml',
    data: [{ k: '报道所述营造防风固沙林', v: '60 多万亩' }, { k: '报道所述控制流沙', v: '近百万亩' }],
    src: '国家林草局，“人民楷模”王有德；2026-04-22 报告文学《治沙人王有德》',
    url: 'https://www.forestry.gov.cn/c/www/lcxjdx/150782.jhtml',
    text: '1985 年到白芨滩防沙林场当场长，带职工一边治沙一边找生计。2014 年退休后接着治沙。2019 年获“人民楷模”国家荣誉称号。' },
];
STORIES.forEach((s, i) => { s.hue = 96 + i * 6; });
const MAIN_STORY = {
  name: '石光银', place: '陕西定边 · 狼窝沙',
  intro: '1984 年，石光银在定边承包了 3000 多亩荒沙。狼窝沙头两年栽下的树苗，九成、八成被风沙毁掉；1988 年换了办法，十年后这片地的植被覆盖率到了 92.5%。下面四段都来自新华社和中国绿色时报的报道。',
  photo: 'assets/img/people/shiguangyin.jpg',
  photoRemote: 'https://www.forestry.gov.cn/html/main/main_586/20210707064829670308073/20210707065305513266720.jpg',
  photoCaption: '石光银在自己最早治理的“狼窝沙”林地里（2020 年 5 月 30 日）',
  photoCredit: '新华社记者 刘潇 摄',
  photoSource: 'http://www.forestry.gov.cn/c/www/rwjj/5796.jhtml',
  chapters: [
    { year: 1984, title: '卖了 84 只羊和 1 头骡子', text: '他办起全国第一家农民股份制治沙公司，承包下 3000 多亩荒沙。买树苗要钱，家里的 84 只羊和 1 头骡子都卖了。', source: 'https://www.forestry.gov.cn/c/www/dxsj/55.jhtml' },
    { year: 1986, title: '两年，树苗九成、八成被毁', text: '春天，他带 100 多人进了狼窝沙。树苗全靠人一捆一捆背进沙窝；吃风吹干的玉米馍，喝沙坑里澄出来的水，住柳条和塑料布搭的小庵子。那年刮了 10 多次六级以上大风，栽下的树苗 90% 被毁。第二年又干了一个春天，80% 又没了。', source: 'https://www.forestry.gov.cn/c/www/lhgzdt/32801.jhtml' },
    { year: 1988, title: '画格子扎沙障，再种灌草和树', text: '他外出学了障蔽治沙法：在迎风坡画格子扎沙障，让沙丘不再流动；沙障之间撒沙蒿、栽沙柳，丘间低地种杨柳。6000 亩地上搭了 800 多公里沙障，成活率到了 80% 左右。1998 年核查，这片地植被覆盖率 92.5%。', source: 'https://www.forestry.gov.cn/c/www/lhgzdt/32801.jhtml' },
    { year: 2021, title: '七一勋章，和接班的孙子', text: '2021 年 6 月 29 日，他在人民大会堂获得“七一勋章”。孙子石健阳高中毕业后学了林业技术，成了家里第三代治沙人。', source: 'https://www.forestry.gov.cn/c/www/dxsj/55.jhtml' },
  ],
  sourceNote: '依据公开报道整理，没有虚构对话。石光银的林地在陕西定边；首屏影像窗口以宁夏盐池县城为中心，两处不是同一块地。',
};
const GEO = {
  bbox: { lonMin: 107.30, lonMax: 110.60, latMin: 37.30, latMax: 39.60 },
  places: [
    { name: '榆林', lon: 109.74, lat: 38.29, size: 3 },
    { name: '鄂尔多斯', lon: 109.78, lat: 39.61, size: 3 },
    { name: '乌审旗', lon: 108.85, lat: 38.62, size: 2 },
    { name: '神木', lon: 110.49, lat: 38.83, size: 2 },
    { name: '靖边', lon: 108.80, lat: 37.60, size: 2 },
    { name: '定边', lon: 107.60, lat: 37.58, size: 2 },
    { name: '盐池', lon: 107.40, lat: 37.79, size: 2 },
  ],
  // 旧工程中的手绘河道仅作位置示意，不作为精确水系数据。
  yellowRiver: [[106.60,39.60],[107.10,39.30],[107.60,39.10],[108.20,39.35],
    [108.90,39.75],[109.60,39.95],[110.30,40.00],[110.90,39.70],[111.20,39.20],
    [110.80,38.60],[110.35,38.30],[110.10,37.80],[110.30,37.30],[110.90,36.90],[111.40,36.40]],
};
const SOURCES = [
  { cat: '数据产品', name: 'USGS · Landsat Collection 2 地表反射率', use: '提供 30 米原始产品；本站全区域序列沿用工程的 500 米处理结果，原始导出待补', url: 'https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-reflectance', grade: '产品说明' },
  { cat: '方法', name: 'NASA · NDVI 与 EVI', use: '解释植被指数的含义；指数不直接等于治理率或土地分类', url: 'https://science.nasa.gov/earth/earth-observatory/measuring-vegetation-ndvi-evi/', grade: '方法参考' },
  { cat: '区域背景', name: '《中国农学通报》· 毛乌素植物资源', use: '2006 年文献所述约 4.22 万平方公里，与本站研究矩形区分', url: AREA.url, grade: '文献' },
  { cat: '行政统计', name: '国家林草局 · 榆林治理情况', use: '2023-09-28 报道的榆林市沙化土地治理率 93.24%，以及固沙措施', url: 'https://www.forestry.gov.cn/c/www/dfdt/522132.jhtml', grade: '已核对报道' },
  { cat: '目标口径', name: '国家林草局 · 鄂尔多斯春季造林', use: '2025-02-19 报道中 85% 为年度目标，不能写成已完成成效', url: 'https://www.forestry.gov.cn/c/www/tpzl/610462.jhtml', grade: '已核对报道' },
  { cat: '人物', name: '新华社 · 石光银', use: '1984 年承包荒沙、狼窝沙治理、长期管护及代际传承；2021-07-07', url: 'https://www.forestry.gov.cn/c/www/dxsj/55.jhtml', grade: '已核对报道' },
  { cat: '人物', name: '中国绿色时报 · 狼窝沙治理', use: '1986、1987 年挫折及 1988 年调整方法；不同报道的成活率略有差别，本站不采用精确比例', url: 'https://www.forestry.gov.cn/c/www/lhgzdt/32801.jhtml', grade: '已核对报道' },
  { cat: '人物', name: '国家林草局 · 殷玉珍', use: '2026-06-07 人物报道，不将报道中的人物数字混作遥感结果', url: 'https://www.forestry.gov.cn/lyj/1/hmgzdt/20260607/674167.html', grade: '已核对报道' },
  { cat: '人物', name: '国家林草局 · 牛玉琴', use: '2023-07-04 人物报道及林区管理', url: 'https://www.forestry.gov.cn/lyj/1/hmjyjl/20230704/513317.html', grade: '已核对报道' },
  { cat: '人物', name: '国家林草局三北局 · 王有德', use: '2024-02-20 报道中的长期治沙与退休后荒滩治理', url: 'https://www.forestry.gov.cn/c/www/qtgz/546241.jhtml', grade: '已核对报道' },
  { cat: '外部研究', name: 'Chen 等 · 全球叶面积变化', use: '2000—2017 研究，中国贡献约 25% 全球净增叶面积；不代表毛乌素或天然森林统计', url: 'https://escholarship.org/uc/item/5k95r370', grade: '论文' },
  { cat: '外部案例', name: 'NSIDC · 2025 北极海冰最小范围', use: '2025-09-17 通报的 4.60 百万平方公里；完整逐年曲线尚未接入', url: GLOBAL.arctic.url, grade: '已核对端点' },
  { cat: '外部案例', name: 'NASA · 萨赫勒与荒漠化', use: '降水驱动的恢复与局地退化不能合并成单向扩张叙事', url: 'https://science.nasa.gov/earth/earth-observatory/defining-desertification/', grade: '解释资料' },
];
const CAVEATS = [
  { t: '研究范围', d: '统计覆盖 107.3°E—110.6°E、37.3°N—39.6°N 的研究矩形，包含不同土地类型。它不是官方毛乌素边界。文献中的 4.22 万 km² 不用作这个矩形的面积。' },
  { t: '年份含义', d: '地图标注的是工程所定义的年度合成结果：生长季（6—9 月）中位数与三年滑窗，不是某一天的照片。序列从 1986 年开始，不意味着全国此前没有 Landsat 数据。' },
  { t: '遥感序列', d: '本站保留工程随附的逐年数组。本次检查计算与页面口径，未重跑原始 GEE 处理。跨传感器差异、云处理和合成方式可能影响数值，主结论采用五年窗口。' },
  { t: '基期低植被区', d: '以 1986—1990 年 NDVI &lt; 0.15 定义固定子集，约占研究矩形 31.7%。阈值不能识别地类，不能证明排除了农田，也不能称为流动沙地范围。' },
  { t: '覆盖度估算', d: '像元二分模型采用 NDVIsoil = 0.0918、NDVIveg = 0.5137。端元选择会影响绝对覆盖度，本站展示同一模型下的变化，不将其与行政治理率相等同。' },
  { t: '显示与差值', d: '端点先显示到一位小数，再以显示端点相减。因此 7.0% → 41.4% 显示增加 34.4 个百分点；按未舍入均值计算的差为 34.48 个百分点。两种计算口径分别说明。' },
  { t: '示意曲线', d: '治理面积、沙尘日数、地下水和泥沙曲线保留旧工程锚点并插值，未接入完整原表。它们不作为实测证据，不参与主结论；本版取消为逼真效果额外添加的年度扰动。' },
  { t: 'MODIS', d: '随包没有 MODIS 逐年数据和处理记录。旧版 +44%、r = 0.94 暂停引用，不能据两个常量宣称独立验证。' },
  { t: '行政统计', d: '榆林市 93.24% 来自 2023 年报道；鄂尔多斯 85% 来自 2025 年年度目标。地域、时间和定义不同，不能相加或与遥感覆盖度直接比较。' },
  { t: '地图点查', d: '点查使用 264×184 的降采样图集并由色带反解，显示局部网格的近似变化；它比全幅导出图粗，不能作为单棵树或精确地点的测量。该曲线不等于区域均值。' },
  { t: '变化原因', d: '影像说明植被状态的变化。治理过程由有来源的人物和工程资料解释；本站没有开展归因研究，不能把全部变化只归因于治理，也不能把绿色增加等同于所有生态问题解决。' },
  { t: '首屏影像窗口', d: '30 米对比窗口为 107.32°E—107.50°E、37.70°N—37.88°N，中心是宁夏盐池县城（花马池镇），东距陕西定边县城约 18 公里。窗口里有城区、农田和沙地；石光银治理的狼窝沙在定边县境内，与这个窗口不是同一块地。' },
  { t: '四十年变化图', d: '由 40 张年度 NDVI 图逐像元计算两个五年窗口的差值。原图把 NDVI 量化为 255 级、截断在 0—0.7，所以单个像元的差值是近似值。变化图说明植被指数在哪里升降，不区分治理、耕作、降水和城镇建设。' },
  { t: '外部案例', d: '水域、森林、植被与海冰使用不同指标。旧全球曲线为可选示意，不代表全球整体退化，不采用复合退化率。程序图也不是真实卫星影像。' },
];
const GUARDS = [
  { n: 1, t: '先说明数据性质', d: '遥感估算、公开报道和插值示意分别标记；缺少原始记录的数字暂不引用。', ev: 'docs/内容与数据核查.md', k: 'pixel' },
  { n: 2, t: '数字按序列计算', d: '五年窗口由随附数组计算，正文共用结果。缺失值显示破折号。', ev: 'assets/js/data.js', k: 'single' },
  { n: 3, t: '检查计算行为', d: '测试年份范围、窗口均值、缺失值、显示差值以及已修正事实。测试通过不等于遥感原始数据已验证。', ev: 'tests/data.test.cjs', k: 'smoke' },
  { n: 4, t: '保留审计结果', d: '审计脚本检查序列和展示口径，列明缺失的上游材料。旧核验记录与本次检查分开保存。', ev: 'tools/audit_numbers.cjs', k: 'audit' },
];
const TRACES = {
  core: { t: '基期低植被区覆盖度估算', v: () => dispDiff(...HEADLINE.fvcCore, 1) + ' 个百分点', chain: [
    ['统计对象', '固定的基期低植被子集；不是官方沙地边界，也不是土地分类'],
    ['时间窗口', '1987—1991 均值 → 2020—2024 均值'],
    ['模型', '工程随附 FVC 数组，像元二分模型；端元 0.0918 / 0.5137'],
    ['显示口径', '7.0% → 41.4%；显示端点差 34.4 个百分点，未舍入均值差 34.48 个百分点'],
    ['复核范围', '本次检查数组计算与页面一致；GEE 原始导出及参数记录待补'],
  ] },
  fvc: { t: '研究矩形覆盖度估算', v: () => dispDiff(...HEADLINE.fvc, 1) + ' 个百分点', chain: [
    ['研究范围', '107.3°E—110.6°E，37.3°N—39.6°N 的矩形，含多种土地类型'],
    ['时间窗口', '1987—1991 → 2020—2024，五年均值'], ['定义', 'FVC 模型估算，不是行政统计治理率'],
  ] },
  ndvi: { t: '生长季 NDVI 变化', v: () => fmtNum(HEADLINE.ndvi[1] - HEADLINE.ndvi[0]), chain: [
    ['计算', '由随附 40 年区域均值序列，分别取首尾五年窗口'], ['含义', '植被状态指数，不等同森林面积'],
    ['限制', '跨传感器和处理差异未独立复核；没有治理因果分析'],
  ] },
  change: { t: '四十年变化图', v: () => (CHANGE.shareRise010 * 100).toFixed(0) + '% 的面积 NDVI 上升超过 0.1', chain: [
    ['输入', '工程随附的 40 张年度 NDVI 图（1100×772，对应 500 米处理网格）'],
    ['解码', 'PNG 内嵌色表：索引 × 0.7 / 254 = NDVI；色表已由 tools/verify_palette.py 逐通道核对'],
    ['计算', '逐像元求 1987—1991 与 2020—2024 两个五年均值，相减得到变化量'],
    ['结果', '上升超过 0.1：' + (CHANGE.shareRise010 * 100).toFixed(1) + '%；上升超过 0.05：' + (CHANGE.shareRise005 * 100).toFixed(1) + '%；下降超过 0.1：' + (CHANGE.shareFall010 * 100).toFixed(2) + '%'],
    ['自检', '解码后的区域均值 ' + CHANGE.regionMean[0] + ' → ' + CHANGE.regionMean[1] + '，与页面使用的年度序列五年均值一致'],
    ['读法', '变化量反映植被指数，耕地、城镇扩建、降水和治理都会影响它；下降集中在城区'],
    ['复现', 'py -3 tools/make_change_map.py → assets/data/change/'],
  ] },
  phases: { t: '三段变化', v: () => PHASES.map((p) => p.start + '—' + p.end).join(' / '), chain: [
    ['输入', '区域 NDVI 年度序列（页面主曲线）'],
    ['方法', '三段直线最小二乘拟合，每段不少于 5 年，取误差最小的两个分界年'],
    ['结果', PHASES.map((p) => p.start + '—' + p.end + '：每年 ' + (p.slope >= 0 ? '+' : '') + p.slope.toFixed(4)).join('；')],
    ['读法', '分段描述曲线形状。同期事件只标注时间，不作为原因判断'],
  ] },
  modis: { t: 'MODIS 暂未核验', v: () => null, chain: [ ['现状', '未随包提供逐年序列、处理脚本或原始结果'], ['处理', '暂停引用 +44% 和 r = 0.94，不宣称独立验证'] ] },
  sediment: { t: '泥沙数列暂不作证据', v: () => null, chain: [ ['现状', '旧工程曲线的逐年公报表格未核对'], ['处理', '作为插值示意保留，不显示实测标记，不引用降幅'], ['范围', '潼关站属于流域尺度，不能归为毛乌素单独贡献'] ] },
  pixel: { t: '旧像素核验记录', v: () => null, chain: [ ['历史记录', '旧 evidence.js 随附像素差异摘要'], ['本次状态', '缺少原始报告、CSV 和对应工具，未复跑'], ['结论边界', '颜色反解一致性也不能证明原始观测或治理归因正确'] ] },
  checks: { t: '本次可运行检查', v: () => null, chain: [ ['运行', 'node --test tests/data.test.cjs'], ['审计', 'node tools/audit_numbers.cjs'], ['产物', 'docs/数字审计结果.json'], ['范围', '检查随附数组、代码约束和展示口径，不声称复核 GEE 数据'] ] },
  roads: { t: '参考道路图层', v: () => '位置参考', chain: [ ['来源', '旧工程随附 OpenStreetMap 处理结果，来源记录见 roads.js'], ['时间', '是当前参考路网，不是各历史年份的路网'], ['精度', '经简化，仅供方位参考，不用于精确测量或治理归因'] ] },
  admin: { t: '参考行政区划', v: () => '位置参考', chain: [ ['来源', '旧工程随附 DataV 区划结果，许可台账需补齐'], ['时间', '并非逐年历史区划'], ['精度', '简化边界只用于定位，不代替法定行政边界'] ] },
  zoomres: { t: '地图尺度与清晰度', v: () => '概览与细节分开读', chain: [
    ['全区概览', '保留工程 500 米处理尺度；1100×772 展示图不等于获得更细观测'],
    ['局部细节', 'Landsat Collection 2 原始地表反射率产品有 30 米数据，可以重新处理局部窗口'],
    ['边界', '放大或插值不能恢复原图不存在的真实细节；局部影像不改变现有全区统计'],
    ['来源', 'USGS Landsat Collection 2 Surface Reflectance 官方说明'],
  ] },
  globalimg: { t: '外部案例示意画面', v: () => '程序示意图', chain: [ ['图像', '当前四例为程序绘制，不是真实卫星影像'], ['数列', '稀疏旧锚点插值，北极 2025 端点已修正为官方 4.60'], ['限制', '指标不能等价比较，也不能据此概括全球退化'] ] },
  boundary: { t: '低 NDVI 区域', v: () => '阈值 NDVI < 0.12', chain: [ ['判据', '由当前年度降采样图集中低于 0.12 的网格勾勒'], ['含义', '仅表示低植被指数，可能包含多种地表'], ['边界', '不等于裸沙分类、流动沙地或官方沙地边界'] ] },
  groundwater: { t: '地下水数列暂未核实', v: () => null, chain: [ ['现状', '旧锚点未提供井号、逐年观测和统计口径'], ['处理', '仅保留插值示意，不引用回升量'] ] },
};
const REFUSES = [
  { r: '把低 NDVI 区叫作真实沙地', why: '阈值没有识别土地类型。', use: '称为基期低植被区，并说明定义。' },
  { r: '把覆盖度估算叫作治理率', why: '模型与行政统计的定义不同。', use: '按各自范围、时段和口径分别展示。' },
  { r: '用两个常量证明 MODIS 独立验证', why: '没有随附逐年序列和处理记录。', use: '暂停引用，补齐资料后再计算。' },
  { r: '把插值和随机扰动当年度实测', why: '中间年份不是观测。', use: '显式标注趋势示意，取消额外年度扰动。' },
  { r: '把四个外部案例合成为全球退化率', why: '指标不同，也不是代表性抽样。', use: '保留可选资料，不采用复合指标。' },
  { r: '把旧 117/117 当本次检查', why: '旧工具和原始报告未随包提供。', use: '保留历史摘要，本次检查提供可运行脚本。' },
  { r: '用放大或 AI 补出遥感细节', why: '视觉细节不能替代真实观测。', use: '概览保留原尺度，局部细节采用有来源的数据。' },
];
const TOUR = [
  { k: 'title', t: '同一片土地，四十年以后', s: '毛乌素沙地 · {y0}—{y1}', d: '先拖动首屏的对比手柄。两侧覆盖同一研究范围，采用相同色标；这里的绿色表示植被指数，不是真彩色照片。', sec: '#hero', year: 'start', hold: 15000, tip: '拖动对比 · 也可以点下一步' },
  { k: 'beforeafter', t: '怎么让树苗留下来', s: '从固沙到管护', d: '固沙、选择适合的植物和长期管理，需要配合进行。下面的机制示意依据公开治理资料，不是历史现场录像。', sec: '#beforeafter', hold: 18000, tip: '看三个步骤，再进入地图' },
  { k: 'people', t: '狼窝沙，种下去又被毁坏', s: '石光银与乡亲们', d: '1986 年开始治理狼窝沙，早期树苗遭风沙破坏。他们请教技术人员，调整为先设沙障、再结合灌草与树木种植。人的行动由报道说明，区域变化由影像观察。', sec: '#story', year: 'start', hold: 23000, tip: '人物经历有出处，不把整个研究区归为个人林地' },
  { k: 'start1986', t: '从哪里开始看', s: '{y0} 年合成影像', d: '先记住一个位置。沿着同一地点向后看，才能知道后来哪些地方增加了植被、哪些地方仍然稀疏。', sec: '#stage', year: 'start', hold: 15000, panelGlobal: false, tip: '绿表示较高 NDVI，浅色表示较低 NDVI' },
  { k: 'timeline', t: '变化需要一段时间', s: '逐年观看，随时暂停', d: '时间轴展示工程随附的 {n} 年合成结果。可以暂停，比较同一个位置；年份是合成标记，不代表拍摄的某一天。', sec: '#stage', year: 'start', play: true, hold: 30000, panelGlobal: false, tip: '空格暂停 · 左右方向键逐年查看' },
  { k: 'core', t: '把变化算出来', s: '固定子集 · 相同模型', d: '基期低植被区的覆盖度估算，五年窗口由 {coreLo}% 变为 {coreHi}%。显示端点相差 {corePp} 个百分点。这个子集按 NDVI 阈值划定，不能直接叫作真实沙地。', sec: '#panel', year: 'end', hold: 22000, tip: '点击数字，查看统计范围和计算方式' },
  { k: 'today', t: '今天看见了什么', s: '前后对比', d: '回到相同地点，检查植被颜色和斑块的变化。影像可以说明地表状态，生活改善、物种恢复等问题还需要对应调查，不能由绿色直接推断。', sec: '#stage', year: 'end', ab: YEAR_START, hold: 20000, tip: '拖动分界线，让两侧覆盖同一地点' },
  { k: 'method', t: '这些结论的范围', s: '来源、估算与限制', d: '遥感估算、行政统计和趋势示意分别说明。缺少原始资料的数字暂不引用；本次计算检查与旧核验摘要分开记录。', sec: '#method', trace: 'core', hold: 20000, tip: '按 Esc 退出导览，继续自己查看' },
];
function fmtNum(v, d) {
  return typeof v !== 'number' || !Number.isFinite(v) ? '—' : v.toFixed(d == null ? 3 : d);
}
function dispDiff(a, b, dec) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const digits = dec == null ? 1 : dec;
  return fmtNum(+b.toFixed(digits) - +a.toFixed(digits), digits);
}
const PROLOGUE = {
  lede: '先让沙稳定下来，再让植被生长。',
  ledeSub: '下面说明治理中常见的几个步骤。各地措施需要结合地形、水分和土壤选择，不能照搬同一种办法。',
  frames: [
    { k: 'sand', no: '01', mark: '固沙', title: '减弱近地风力', line: '沙障帮助稳定流沙，为后续植物生长创造条件。', photo: null, photoNote: '机制示意', when: '步骤示意', credit: '依据公开资料绘制' },
    { k: 'planting', no: '02', mark: '种植', title: '选择适合当地的植物', line: '根据立地条件配置灌草与树木，让植被逐步参与固沙。', photo: null, photoNote: '机制示意', when: '步骤示意', credit: '依据公开资料绘制' },
    { k: 'greening', no: '03', mark: '管护', title: '种活以后继续管理', line: '补植、更新和保护同样重要。长期恢复还要考虑水资源承载能力。', photo: null, photoNote: '机制示意', when: '步骤示意', credit: '依据公开资料绘制' },
  ],
  claim: { t: '变化过程与证据一起看', d: '基期低植被区覆盖度估算 <b><span class="trace" data-trace="core">{coreLo}% → {coreHi}%</span></b>。这是同一模型下的五年窗口结果；具体治理过程由公开资料说明。' },
};
window.DATA = {
  CHANGE, PHASES, YEARS, YEAR_START, YEAR_END, MU_US, MU_SERIES, AREA, STATIC, GLOBAL, GLOBAL_SERIES,
  FACTS, MILESTONES, STORIES, MAIN_STORY, GEO, SOURCES, CAVEATS, HEADLINE, FACTS_NUM,
  WIN, fmtNum, dispDiff, winMean, GUARDS, TRACES, REFUSES, TOUR, PROLOGUE, mulberry32,
};
