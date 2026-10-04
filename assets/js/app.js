/* ==========================================================================
 * app.js  ·  状态机与交互编排
 * 全局唯一状态：currentYear；所有视图（地图 / 全球对照 / 卡片 / 图表）订阅它
 * ========================================================================== */
(function () {
  const D = window.DATA, R = window.RENDER, C = window.CHARTS;
  const { YEARS, YEAR_START, YEAR_END, MU_SERIES, GLOBAL_SERIES, STORIES, MILESTONES, SOURCES, FACTS, TOUR } = D;
  const Y0 = MU_SERIES.cover.length - 1;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let year = YEAR_START;
  /* 首屏初始化期间不做任何预取，保证「打开页面只下载 1 张贴图」 */
  let booted = false;
  /* 主舞台首次自动播放只做一次；导览开始时置真，免得它插一脚 */
  let autoDone = false;
  let playing = false, playTimer = null;
  /* 用户正按着某张折线图拖年份游标（CHARTS.onDrag 维护）。
   * 拖动期地图也走图集预览 —— 一次拖过 40 年若逐年拉高清就是 25 MB 请求，
   * 而拖动中看不清细节，松手补当年高清即可。跟 playing 是同一类「快速跨年」场景，
   * 所以并进 drawMap 的 atlasOnly 判定，而不是另开一条渲染路径。 */
  let chartDragging = false;
  /* 播放节奏：200 ms/年 → 40 年 8.0 s（2026-10-03 晚 10 从 135 ms 调过来，
   * 按你给的导览 JSON 里的 playMs 定死；导览第 4 步「四十年的变化压进十秒」说的
   * 就是这个数）。改这一处即可全局调整；
   * 开发者面板的滑块会写 localStorage.override，**只在调试时生效**，
   * 正式提交前用面板的「恢复默认」清掉，避免评测时慢得不正常。 */
  const DEV = {
    playMs: 200,
    load: () => {
      try {
        const o = JSON.parse(localStorage.getItem('mu.dev') || '{}');
        if (o && typeof o.playMs === 'number' && o.playMs >= 30 && o.playMs <= 600) DEV.playMs = o.playMs;
        return o || {};
      } catch (e) { return {}; }
    },
    save: (o) => { try { localStorage.setItem('mu.dev', JSON.stringify(o)); } catch (e) { /* 无痕模式等 */ } },
    clear: () => { try { localStorage.removeItem('mu.dev'); } catch (e) { /* 同上 */ } },
  };
  const layers = { roads: true, admin: false, boundary: true, river: true, places: true, grid: false };

  /* ================= 视图配置 ================= */
  const STATS = [
    { k: '区域 NDVI', key: 'ndvi', unit: '', dec: 3, good: 'up', color: '#4ec97a' },
    { k: '区域覆盖度 · 模型估算', key: 'cover', unit: '%', dec: 1, good: 'up', color: '#4ec97a' },
    { k: '基期低植被区 NDVI', key: 'ndviCore', unit: '', dec: 3, good: 'up', color: '#c9b070' },
    { k: '低植被区覆盖度 · 模型估算', key: 'coverCore', unit: '%', dec: 1, good: 'up', color: '#c9b070' },
    { k: '累计治理面积', key: 'treated', unit: '万亩', dec: 0, good: 'up', color: '#8fa38a', est: true },
    { k: '年沙尘日数', key: 'dust', unit: '天', dec: 0, good: 'down', color: '#8fa38a', est: true },
    { k: '地下水位回升', key: 'groundwater', unit: 'm', dec: 2, good: 'up', color: '#8fa38a', est: true },
  ];

  /* 每处对应两个时点的真实影像（1988 / 2025，由 GEE 导出，见 tools/gee_global_tiles.md）。
   * imgs 为空时**自动退回程序化合成**并在图角标注「示意图」——
   * 不因为图没到位就开天窗，也不静默假装是真实影像（红线：禁止静默 fallback）。 */
  const GLOBAL_IMG = {};
  const GLOBAL_YEARS = [1988, 2025];
  const GLOBALS = [
    { key: 'aral', src: 'aral', name: '咸海', meta: '中亚 · 水域面积示意序列', fn: R.renderAral, bad: 'shrink' },
    { key: 'amazon', src: 'amazon', name: '亚马逊', meta: '巴西 · 累计森林损失示意序列', fn: R.renderAmazon, bad: 'grow' },
    { key: 'sahel', src: 'sahel', name: '萨赫勒', meta: '植被变化案例 · 不代表单向退化', fn: R.renderSahara, bad: 'grow' },
    { key: 'arctic', src: 'arctic', name: '北极海冰', meta: '9月最小范围 · 锚点插值示意', fn: R.renderArctic, bad: 'shrink' },
  ];

  /* 预加载全球对照的真实影像；onload 后重画。
   * 失败（文件不存在）走 onerror 静默记 0 —— 页面继续用合成图，不报错、不打断。 */
  function preloadGlobalImgs() {
    let done = 0, total = 0;
    GLOBALS.forEach((g) => {
      GLOBAL_IMG[g.key] = {};
      GLOBAL_YEARS.forEach((y) => {
        const im = new Image();
        im.decoding = 'async';
        im.loading = 'lazy';
        const p = `assets/img/global/${g.key}_${y}.png`;
        total++;
        im.onload = () => { GLOBAL_IMG[g.key][y] = im; if (++done === total) drawGlobals(); };
        im.onerror = () => { /* 保持 undefined → 走合成图 */ };
        im.src = p;
      });
    });
    window.GLOBALIMG = {
      get real() {
        let n = 0;
        for (const k in GLOBAL_IMG) for (const y in GLOBAL_IMG[k]) n++;
        return n;
      },
      get total() { return GLOBALS.length * GLOBAL_YEARS.length; },
    };
  }

  /* 选图：按当前年份在两个时点里就近取（早于 2006 取 1988，之后取 2025）——
   * 两张影像本来就是「两个时代」的对照，不必逐年都有。 */
  function pickGlobalImg(key) {
    const box = GLOBAL_IMG[key];
    if (!box) return null;
    const y = year < 2006 ? 1988 : 2025;
    if (box[y]) return { im: box[y], y };
    const other = y === 1988 ? 2025 : 1988;
    return box[other] ? { im: box[other], y: other } : null;
  }

  /* 地图左下角的读图提示：按三段变化写，内容来自逐年影像的目视读图，不是定量归因 */
  function mapNoteFor(y) {
    if (y <= 2000) return '流动沙地连片，绿色多在河谷、滩地和城镇周边';
    if (y <= 2011) return '植被指数开始上升，绿色沿河谷、道路和城镇向外扩';
    if (y <= 2019) return '绿色斑块连成片，沙丘被切割成碎块';
    return '高位继续上升，残留沙地呈斑块状';
  }

  const MARKS = [
    { y: 1986, label: '起点' }, { y: 1991 }, { y: 1999, label: '退耕还林' },
    { y: 2002 }, { y: 2012 }, { y: 2020, label: '近期窗口' }, { y: 2025 },
  ];

  /* ================= 构建静态 DOM ================= */

  /* 核心沙地提升幅度（pp）：单一真源，算不出就返回 '—' 不用默认值兜底。
   * 算法用「显示端点相减」（见 dispDiff 注释）：41.4 − 7.0 = +34.4，
   * 先减后舍会给出 34.5，与页面端点对不上 —— 核验表判过的错误舍入。 */
  function corePp() {
    const H = D.HEADLINE;
    if (!H || H.fvcCore[0] == null || H.fvcCore[1] == null) return '—';
    return dispDiff(H.fvcCore[0], H.fvcCore[1], 1) || '—';
  }

  /* 首屏两个数：都由工程影像直接算出，点开可看计算链。 */
  function buildHeroStats() {
    const C = D.CHANGE, H = D.HEADLINE;
    if (!C || !H || H.ndvi[0] == null) { $('#heroStats').innerHTML = ''; return; }
    const items = [
      { v: H.ndvi[0].toFixed(2) + ' → ' + H.ndvi[1].toFixed(2), trace: 'ndvi', s: '整片研究区的植被指数（NDVI），头五年与最近五年平均，接近翻倍' },
      { v: (C.shareRise010 * 100).toFixed(0) + '%', trace: 'change', s: '的面积，植被指数上升超过 0.1；明显下降的不到 0.1%，集中在城区' },
      { v: '93.24%', s: '榆林市沙化土地治理率（2023 年国家林草局报道，行政统计）' },
    ];
    $('#heroStats').innerHTML = items
      .map((i) => `<div class="hs"><b>${i.trace ? `<button type="button" class="trace" data-trace="${i.trace}">${i.v}</button>` : `<span data-countup>${i.v}</span>`}</b><span>${i.s}</span></div>`)
      .join('');
  }

  function sparkline(values, color) {
    const w = 100, h = 22, mn = Math.min(...values), mx = Math.max(...values);
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - mn) / (mx - mn || 1)) * (h - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.4" opacity=".75"/>
    </svg>`;
  }

  function buildStatRow() {
    $('#statRow').innerHTML = STATS.map((s, i) => `
      <div class="stat${s.est ? ' est' : ''}" data-i="${i}"${s.est ? ' data-grade="estimate"' : ''}>
        <div class="k">${s.k}${s.est ? '<em class="est-tag">示意 · 非实测</em>' : ''}</div>
        <div class="v"><span class="num">–</span><span class="u">${s.unit}</span></div>
        <div class="d"></div>
        ${sparkline(MU_SERIES[s.key], s.color)}
      </div>`).join('');
  }

  function buildGlobalGrid() {
    $('#globalGrid').innerHTML = GLOBALS.map((g) => `
      <div class="gp" data-k="${g.key}">
        <canvas></canvas>
        <span class="gp-src synth">示意图</span>
        <div class="gp-info">
          <div class="gp-name"><span>${g.name}</span><span class="gp-val">–</span></div>
          <div class="gp-meta">${g.meta}</div>
          <div class="gp-bar"><i style="width:0%"></i></div>
        </div>
      </div>`).join('');
  }

  /* ================= 序章 · 四十年前后（第二屏） =================
   * 定位：全篇的**引言 / 意象**，不是数据屏。
   *   任务是把人留住、把主题摆出来（沙 → 治 → 绿），严谨性交给后面三屏。
   * 三条口径（写死在代码里，改文案时别破坏）：
   *   1. 照片**永远不许被标成某个年份的样子**（「1986 年的毛乌素」等）。
   *      图上只写「治理前 / 治理中 / 治理后 · 年份未标注」。
   *   2. 数字仍走 {token}（TOK 由 HEADLINE 现算）+ .trace 可点开 ——
   *      意象可以有，含糊不行。
   *   3. 图片 404 明确显示「照片缺失」，不留空白框 —— 禁止静默 fallback。 */
  function buildPrologue() {
    const P = D.PROLOGUE;
    if (!P) return;

    /* 开场白 */
    const lede = $('#plLede');
    if (lede) lede.innerHTML = `<p class="pl-lede-main">${P.lede}</p>`
      + `<p class="pl-lede-sub">${P.ledeSub}</p>`;

    /* 三联：沙 → 治 → 绿 */
    const box = $('#plFrames');
    if (box) {
      box.innerHTML = P.frames.map((f) => `
        <figure class="pl-frame" data-pl-frame="${f.k}">
          <div class="pl-shot">
            <img src="${f.photo}" alt="${f.photoNote}（${f.title}）" loading="lazy" data-pl-photo>
            <span class="pl-shot-mark">${f.mark}</span>
            <span class="pl-shot-no">${f.no}</span>
          </div>
          <div class="pl-txt">
            <div class="pl-ftitle"><i>${f.no}</i> ${f.title}</div>
            <p class="pl-fline">${f.line}</p>
            <figcaption class="pl-fcap">
              <span class="pl-fnote">${f.photoNote}</span>
              <span class="pl-fwhen">${f.when} · 图：${f.credit}</span>
            </figcaption>
          </div>
        </figure>`).join('');
      /* 照片加载失败 → 明确显示「照片缺失」，不留空白框。
         图片 404 跟数据 404 一样是 bug，不是「正常」。 */
      $$('#plFrames [data-pl-photo]').forEach((img) => {
        img.addEventListener('error', () => {
          img.classList.add('broken');
          const shot = img.closest('.pl-shot');
          if (shot) shot.classList.add('broken');
        });
      });
    }

    /* 一句话：文案里的 {token} 现算（TOK 与正文同一套，同源） */
    const claim = $('#plClaim');
    if (claim) claim.innerHTML = `<div class="plc-k">一句话</div>`
      + `<div class="plc-t">${P.claim.t}</div>`
      + `<p class="plc-d">${tourText(P.claim.d)}</p>`;
    /* ⚠ 独立成框的「本屏为意象呈现……」注脚已于 2026-10-03 删掉（用户：意义不大）。
     * 口径说明**没有丢**，它在 `.pl-lede-sub` 开场白里：
     * 「下面三张不是同期同机位的对照，也不承担证明；它们只是引子。」
     * 改回归档前先 grep `#plNote`，那边还会有一两条测试断言要跟着改。 */
  }

  function buildStories() {
    /* ⚠ 照片上的「图：×××」署名行已于 2026-10-03 删除（用户：下方来源就够了）。
     * 现在**只在缺授权出处时**留一个黄色角标 —— 那不是装饰，是公开发表的风险兜底：
     * 竞赛材料一旦上网，用了没标明出处的照片是要担责的。
     * 所以 data.js 里的 photoCredit 字段继续留着当授权台账，只是不再显示「已授权」那行字。 */
    $('#storyGrid').innerHTML = STORIES.filter(p => !D.MAIN_STORY || p.name !== D.MAIN_STORY.name).map((p, i) => `
      <article class="story">
        <div class="story-art">
          ${storyArt(i)}
          ${p.photo
            ? `<img class="story-photo" src="${p.photo}" alt="${p.photoCaption || p.name}"${p.photoPos ? ` style="object-position:${p.photoPos}"` : ''} data-photo data-remote="${p.photoRemote || ''}" referrerpolicy="no-referrer" loading="lazy" decoding="async">`
              + `<a class="photo-credit" href="${p.photoSource || p.url}" target="_blank" rel="noopener">${p.photoCredit || '照片出处待补'}</a>`
            : '<span class="art-badge">示意插画 · 非本人照片</span>'}
        </div>
        <div class="story-body">
          <div class="story-name">${p.name}</div>
          <div class="story-place">${p.place} · ${p.years}</div>
          <div class="story-tag">${p.tag}</div>
          <div class="story-quote-txt">${p.quote ? '“' + p.quote + '”' + (p.quoteSrc ? '<span class="story-quote-src">' + (p.quoteUrl ? '<a href="' + p.quoteUrl + '" target="_blank" rel="noopener">' + p.quoteSrc + '</a>' : p.quoteSrc) + '</span>' : '') : ''}</div>
          <p class="story-text">${p.text}</p>
          <div class="story-data">
            ${p.data.map((d) => `<div><span>${d.k}</span><b>${d.v}</b></div>`).join('')}
          </div>
          <div class="story-src">资料：${p.url ? '<a href="' + p.url + '" target="_blank" rel="noopener">' + p.src + '</a>' : p.src}</div>
        </div>
      </article>`).join('');

    /* 照片文件缺失时自动退回插画：不留破图，并补上「示意插画」标注 */
    $$('#storyGrid img[data-photo]').forEach((im) => {
      im.addEventListener('error', () => {
        /* 本地文件不在时先试报道原图（联网可见），两处都失败才退回插画。 */
        if (im.dataset.remote && !im.dataset.triedRemote) { im.dataset.triedRemote = '1'; im.src = im.dataset.remote; return; }
        const art = im.parentElement;
        const credit = art ? art.querySelector('.photo-credit') : null;
        if (credit) credit.remove();
        im.remove();
        if (art && !art.querySelector('.art-badge')) {
          const b = document.createElement('span');
          b.className = 'art-badge';
          b.textContent = '示意插画 · 非本人照片';
          art.appendChild(b);
        }
      });
    });
  }

  /* 四张头图是**示意插画**（不是本人照片），四个人各给一个不同的场景母题，
   * 免得四张长得一模一样。要上授权照片，把 STORIES[i].photo 指到图即可
   * （命名与授权要求见 site/assets/img/people/README.md）。 */
  const STORY_ART = [
    { hue: 96, motif: 'gully' },   /* 殷玉珍：井背塘，沙丘间的浅沟 + 稀疏幼树 + 远处林带 */
    { hue: 74, motif: 'grid' },    /* 石光银：狼窝沙，草方格固沙 + 樟子松 */
    { hue: 116, motif: 'belt' },   /* 牛玉琴：旺琴林场，等距三代林带 */
    { hue: 148, motif: 'canal' },  /* 王有德：白芨滩，扬黄灌溉水渠 + 两侧林带 */
  ];

  function storyArt(i) {
    const cfg = STORY_ART[i % STORY_ART.length];
    const hue = cfg.hue;
    const dune = (y, k) => `M0,${y + k} C50,${y - 12 + k} 110,${y + 16 + k} 165,${y + k} C215,${y - 14 + k} 262,${y + 12 + k} 300,${y - 2 + k} L300,132 L0,132 Z`;
    const seed = D.mulberry32(17 + i * 31);
    const tree = (x, base, hh, op) => {
      const c = `hsl(${hue - 6 + seed() * 20} 42% ${26 + seed() * 12}%)`;
      return `<g opacity="${op == null ? .95 : op}">
        <rect x="${x}" y="${base - hh}" width="1.6" height="${hh}" fill="#0d1a12"/>
        <ellipse cx="${x + 0.8}" cy="${base - hh - 4}" rx="${hh * 0.34}" ry="${hh * 0.42}" fill="${c}"/>
      </g>`;
    };
    let fore = '';
    if (cfg.motif === 'gully') {
      fore = '<path d="M0,112 C40,104 70,118 110,112 C150,106 190,120 240,112 L300,112 Z" fill="hsl(36 28% 24%)" opacity=".9"/>';
      for (let t = 0; t < 5; t++) fore += tree(26 + t * 30 + seed() * 10, 112, 9 + seed() * 7);
      for (let t = 0; t < 12; t++) fore += tree(6 + t * 25 + seed() * 12, 96, 14 + seed() * 10, .45);
    } else if (cfg.motif === 'grid') {
      const cells = [];
      for (let gx = -26; gx < 330; gx += 26) {
        cells.push(`<line x1="${gx}" y1="132" x2="${gx + 52}" y2="88"/>`);
        cells.push(`<line x1="${gx + 52}" y1="132" x2="${gx}" y2="88"/>`);
      }
      fore = '<path d="M0,96 C60,88 140,100 200,92 C250,86 280,96 300,92 L300,132 L0,132 Z" fill="hsl(36 26% 26%)" opacity=".85"/>'
        + `<g stroke="hsl(44 34% 46%)" stroke-width="1.1" opacity=".5" fill="none">${cells.join('')}</g>`;
      for (let t = 0; t < 4; t++) fore += tree(34 + t * 62 + seed() * 12, 100, 18 + seed() * 10);
    } else if (cfg.motif === 'belt') {
      for (let row = 0; row < 3; row++) {
        const base = 106 + row * 9;
        for (let t = 0; t < 9; t++) {
          fore += tree(8 + t * 33 + (row % 2) * 13, base, 20 + row * 3, .92 - row * .2);
        }
      }
    } else {
      fore = '<path d="M0,104 C80,100 200,110 300,104 L300,116 C200,122 80,112 0,116 Z" fill="hsl(199 52% 42%)" opacity=".85"/>'
        + '<path d="M0,116 C80,112 200,122 300,116 L300,132 L0,132 Z" fill="hsl(36 26% 24%)" opacity=".9"/>';
      for (let t = 0; t < 7; t++) fore += tree(16 + t * 42 + seed() * 8, 104, 16 + seed() * 8);
      for (let t = 0; t < 6; t++) fore += tree(26 + t * 48 + seed() * 8, 124, 12 + seed() * 6, .8);
    }
    /* preserveAspectRatio 用 meet（完整显示）而不是 slice（裁切放大）：
       slice 在窄屏下会按比例放大并溢出容器 —— 实测 g/line 元素右边界到 444px
       （视口仅 390），把整页撑出横向滚动条。插画宁可留边也不要出血。 */
    return `<svg viewBox="0 0 300 132" preserveAspectRatio="xMidYMid meet" data-motif="${cfg.motif}">
      <defs>
        <linearGradient id="sky${i}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="hsl(${hue - 20} 16% 10%)"/><stop offset="1" stop-color="#0a120e"/>
        </linearGradient>
        <linearGradient id="d1${i}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="hsl(38 32% 34%)"/><stop offset="1" stop-color="hsl(34 28% 22%)"/>
        </linearGradient>
      </defs>
      <rect width="300" height="132" fill="url(#sky${i})"/>
      <circle cx="${52 + i * 60}" cy="${30 + (i % 2) * 12}" r="17" fill="hsl(${hue} 40% 42%)" opacity=".22"/>
      <circle cx="${52 + i * 60}" cy="${30 + (i % 2) * 12}" r="8" fill="hsl(${hue} 50% 62%)" opacity=".5"/>
      <path d="${dune(74, 0)}" fill="url(#d1${i})" opacity=".55"/>
      <path d="${dune(94, 6)}" fill="hsl(36 30% 26%)" opacity=".75"/>
      <path d="${dune(110, 0)}" fill="hsl(${hue} 26% 18%)" opacity=".9"/>
      ${fore}
    </svg>`;
  }

  function buildSources() {
    $('#srcBody').innerHTML = SOURCES.map((s) => `
      <tr>
        <td>${s.cat}</td>
        <td>${s.url ? `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>` : s.name}</td>
        <td>${s.use}</td>
        <td><span class="badge ${s.grade === '主力' ? '' : 'aux'}">${s.grade}</span></td>
      </tr>`).join('');
  }

  /* 静态口径项：没有可靠逐年序列，用区间/极值呈现，不画趋势线 */
  function buildStatic() {
    const rate = FACTS.find(fact => String(fact.num) === '93.24');
    $('#staticCard').innerHTML = '<div class="static-item"><div class="si-k">榆林市沙化土地治理率</div>'
      + '<div class="si-v">93.24<span class="u">%</span></div>'
      + '<div class="si-note">行政统计，与本网站矩形观测范围及遥感覆盖度不是同一口径。</div>'
      + '<div class="si-src">' + (rate ? rate.src : '国家林草局2023年公开报道') + '</div></div>'
      + '<div class="static-item"><div class="si-k">常见毛乌素沙地面积口径</div>'
      + '<div class="si-v">' + (D.AREA.totalKm2 / 10000).toFixed(2) + '<span class="u">万平方公里</span></div>'
      + '<div class="si-note">折合约 6330 万亩。区域统计使用固定矩形；该矩形包含沙地之外的地表，不能等同自然沙地边界。</div>'
      + '<div class="si-src">' + D.AREA.source + '</div></div>'
      + '<div class="static-item"><div class="si-k">年降水量 · 多站多年平均</div>'
      + '<div class="si-v">340—400<span class="u">mm</span></div>'
      + '<div class="si-range"><i style="left:' + (159.6 / 700 * 100).toFixed(1) + '%;right:' + (100 - 689.4 / 700 * 100).toFixed(1) + '%"></i><b style="left:' + (340 / 700 * 100).toFixed(1) + '%;right:' + (100 - 400 / 700 * 100).toFixed(1) + '%"></b></div>'
      + '<div class="si-ticks"><span>0</span><span>旱年 159.6 · 多雨年 689.4</span><span>700</span></div>'
      + '<div class="si-note">各站差异大、年际波动极大，不画逐年趋势，也不把降水说成变绿的唯一原因。</div>'
      + '<div class="si-src">旧工程整理：榆林沙区 415.7 mm（《林业科学研究》）、榆阳区 399.8 mm、横山区 365.7 mm、补浪河站 340 mm；原文链接待补</div></div>'
      + '<div class="static-item"><div class="si-k">乌审旗境内毛乌素沙地治理率</div>'
      + '<div class="si-v">85<span class="u">%</span></div>'
      + '<div class="si-note">治理面积 839.39 万亩。范围是乌审旗，和榆林的 93.24% 统计范围不同，不能合并。</div>'
      + '<div class="si-src">国家林草局转载人民日报海外版，2026-06-07</div></div>';
  }



  /* ================= 方法学视图（第六屏） =================
   * 这一屏的全部对外数字有两个来源，都不在 app.js 里写死：
   *   1) 序列现算 —— 核心沙地增幅走 HEADLINE
   *   2) 核验产物 —— 走 evidence.js（由 tools/gen_evidence.py 从 pixel_check.json 生成）
   * 页面上任何可点开的数字都是 <span class="trace" data-trace="...">，点击弹计算链。 */
  function buildMethod() {
    const evidence = window.EVIDENCE || {};
    $('#guardRow').innerHTML = GUARDS.map(guard => '<div class="guard" data-k="' + guard.k + '">'
      + '<div class="g-n">' + guard.n + '</div><div class="g-b"><div class="g-t">' + guard.t
      + '</div><div class="g-d">' + guard.d + '</div></div><div class="g-ev">' + guard.ev + '</div></div>').join('');
    const records = [
      { label: '逐年区域产品', value: YEARS.length + '年', note: '检查包内序列与资源；不等同上游处理复现', trace: 'ndvi' },
      { label: '基期低植被区覆盖度变化', value: '+' + corePp() + '个百分点', note: '模型估算，比较两个五年窗口', trace: 'core' },
      { label: '原始处理复现', value: '待补充', note: '本包未附完整GEE原始处理工程', trace: 'checks' },
      { label: '独立MODIS验证', value: '待补充', note: '原页面常数缺原始序列，本版停止引用', trace: 'modis' },
    ];
    $('#evGrid').innerHTML = records.map(record => '<div class="ev"><div class="ev-l">' + record.label
      + '</div><div class="ev-v"><button class="trace" data-trace="' + record.trace + '">' + record.value
      + '</button></div><div class="ev-s">' + record.note + '</div></div>').join('');
    $('#evNote').textContent = '本次可运行的数字核查：tools/audit_numbers.cjs。原工程随附的117项通过记录属于历史记录，缺少对应完整工具，不能当作本版已复现结果。';
    $('#refuseList').innerHTML = REFUSES.map(refusal => '<div class="refuse"><div class="rf-r">'
      + refusal.r + '</div><div class="rf-why">' + refusal.why + '</div><div class="rf-use">'
      + refusal.use + '</div></div>').join('');
  }



  /* ---- 数字溯源弹层 ---- */
  let traceTrigger = null;
  function openTrace(key) {
    const T = D.TRACES && D.TRACES[key];
    if (!T) return;
    $('#tmTitle').textContent = T.t;
    const v = T.v ? T.v() : (key === 'pixel' ? '—' : '—');
    $('#tmVal').textContent = (v && v !== '—') ? v : '';
    $('#tmChain').innerHTML = T.chain
      .map((row) => `<dt>${row[0]}</dt><dd>${row[1]}</dd>`).join('');
    traceTrigger = document.activeElement;
    $('#traceModal').hidden = false;
    $('#tmClose').focus({ preventScroll: true });
  }
  function closeTrace() {
    $('#traceModal').hidden = true;
    if (traceTrigger && traceTrigger.focus) traceTrigger.focus({ preventScroll: true });
  }

  function buildFacts() {
    $('#factsRow').innerHTML = FACTS.map((f) => `
      <div class="fact ${f.grade === 'A' ? 'a' : 'b'}">
        <div class="f-num">${f.num}<span class="u">${f.unit}</span></div>
        <div class="f-text">${f.text}</div>
        <div class="f-sub">${f.sub}</div>
        <div class="f-src"><span class="g ${f.grade.toLowerCase()}">${f.grade}</span>${f.url ? '<a href="' + f.url + '" target="_blank" rel="noopener">' + f.src + '</a>' : f.src}</div>
      </div>`).join('');
  }

  function buildCaveats() {
    $('#caveatCard').innerHTML = D.CAVEATS.map((c) => `
      <div class="caveat"><div class="cv-t">${c.t}</div><div class="cv-d">${c.d}</div></div>`).join('');
  }

  function buildMarks() {
    $('#tlMarks').innerHTML = MARKS.map((m) => {
      const p = ((m.y - YEAR_START) / (YEAR_END - YEAR_START)) * 100;
      return `<i style="left:${p}%" data-y="${m.y}"></i>` +
        (m.label ? `<b style="left:${p}%">${m.label}</b>` : '');
    }).join('');
  }

  /* ---------------- 图层树 ----------------
   * 规则：**每个节点都必须有真实的开关对象**，不做"点了没反应"的装饰节点。
   *   - 地图类子节点（data-layer）   → 地图叠加层（与地图上的图层胶囊双向同步）
   *   - 面板类子节点（data-panel）   → 右栏图表卡片 / 全球对照四图 的显隐
   *   - 组节点（data-master）        → 该组全部子节点的总开关，方框显三态（✓ / − / 空）
   *   - 底图（locked）               → 不能关，但**点击要有反馈**（轻抖 + 说明），不做死节点
   */
  let treeNoteDefault = '';            /* 首次构建时抓一次默认文案，底图提示用完要还原 */
  /* 全球对照**默认关**（2026-10-03 晚 10）：导览前几步讲「沙地在变绿」这条主线，
   * 右栏那张全球对照会喧宾夺主；导览第 7 步才自动请上来。
   * ⚠ 这里和 buildLayerTree 里那个 `on: false` 是同一件事的两面，必须一起改 ——
   * 只改一处就会出现「树上打勾、卡片其实藏着」（实测踩过）。 */
  const panelOn = { trend: true, treat: true, dust: true, global: false };
  const PANEL_CHARTS = {
    trend: ['#chNdvi', '#chNdviCore', '#chCover', '#chCoverCore'],
    treat: ['#chRate', '#chTreated'],
    dust: ['#chDust', '#chSed'],
    global: [],                       /* 全球对照是 #globalGrid 里的 canvas 卡片，单独处理 */
  };

  function applyPanel(k) {
    const on = panelOn[k];
    if (k === 'global') {
      const g = $('#globalGrid');
      if (g) g.classList.toggle('off', !on);
      const card = $('.global-card');
      if (card) card.hidden = !on;
      const grid = $('.stage-grid');
      if (grid) grid.classList.toggle('has-global', !!on);
      return;
    }
    (PANEL_CHARTS[k] || []).forEach((sel) => {
      const box = $(sel);
      const card = box && box.closest ? box.closest('.chart-card') : null;
      if (card) card.classList.toggle('off', !on);
    });
  }

  function buildLayerTree() {
    const items = [
      { grp: 'NDVI 时序栅格', on: true, locked: true, sw: '#4ec97a', tag: '底图常开' },
      { grp: null, sub: true, name: '现状道路（参照）', layer: 'roads', on: layers.roads, sw: '#e8763a', tag: '矢量' },
      { grp: null, sub: true, name: '现状区划（参照）', layer: 'admin', on: layers.admin, sw: '#ffe8b4', tag: '矢量' },
      { grp: null, sub: true, name: '低NDVI区域（<0.12）', layer: 'boundary', on: layers.boundary, sw: '#ff8a2a', tag: '矢量' },
      { grp: null, sub: true, name: '黄河（几字弯）', layer: 'river', on: true, sw: '#5aa9de', tag: '矢量' },
      { grp: null, sub: true, name: '地名注记', layer: 'places', on: true, sw: '#e7f3ec', tag: '矢量' },
      { grp: null, sub: true, name: '经纬网', layer: 'grid', on: false, sw: '#8fa3b0', tag: '参考' },
      { grp: '统计图层', on: true, sw: '#6fe3a2', tag: '8 图' },
      { grp: null, sub: true, name: 'NDVI / 植被覆盖度', panel: 'trend', on: true, sw: '#6fe3a2', tag: '4 图' },
      { grp: null, sub: true, name: '治理率 / 治理面积（示意）', panel: 'treat', on: true, sw: '#6fe3a2', tag: '2 图' },
      { grp: null, sub: true, name: '沙尘 / 入黄泥沙（示意）', panel: 'dust', on: true, sw: '#5aa9de', tag: '2 图' },
      { grp: '全球对照样本', on: true, sw: '#d8b46a', tag: '4 处' },
      /* 默认**不勾**（2026-10-03 晚 10）：导览前几步要的是「沙地在变绿」这条主线，
       * 右栏那张全球对照会喧宾夺主；导览第 7 步才由 setPanelGlobal(true) 自动请上来。
       * 注意这里写 on:false 和 panelOn.global=false 是同一件事的两面，都要改，
       * 只改一处会出现「树上打勾、卡片其实藏着」。 */
      { grp: null, sub: true, name: '咸海 · 亚马逊 · 撒哈拉 · 北极', panel: 'global', on: false, sw: '#d8b46a', tag: '同步' },
    ];
    const noteEl = $('#treeNote');
    if (noteEl) treeNoteDefault = noteEl.textContent;
    $('#layerTree').innerHTML = items.map((it) => {
      if (it.grp) {
        return `<div class="tnode ${it.on ? 'on' : ''}${it.locked ? ' locked' : ''}"
          title="${it.locked ? '底图常开，不可关闭' : '点击可整组开/关'}"
          ${it.locked ? '' : 'data-master="1"'}>
          <span class="box">${it.on ? '✓' : ''}</span>
          <span class="sw" style="background:${it.sw}"></span>
          <span>${it.grp}</span>${it.locked ? '<span class="lock">锁定</span>' : ''}<span class="tag">${it.tag}</span></div>`;
      }
      const key = it.layer ? `data-layer="${it.layer}"` : `data-panel="${it.panel}"`;
      return `<div class="tnode sub ${it.on ? 'on' : ''}" ${key} title="点击开/关">
        <span class="box">${it.on ? '✓' : ''}</span>
        <span class="sw" style="background:${it.sw};opacity:.7"></span>
        <span>${it.name}</span><span class="tag">${it.tag}</span></div>`;
    }).join('');

    $$('#layerTree [data-layer], #layerTree [data-panel]').forEach((n) => {
      n.addEventListener('click', () => { toggleTreeNode(n); syncURL(); });
    });
    /* 组节点：整组开/关（任一子节点本来是开的就全关，否则全开） */
    $$('#layerTree [data-master]').forEach((n) => {
      n.addEventListener('click', () => {
        const kids = groupChildren(n);
        if (!kids.length) return;
        const anyOn = kids.some((k) => k.classList.contains('on'));
        kids.forEach((k) => toggleTreeNode(k, !anyOn));
        paintGroups();
        syncURL();
      });
    });
    /* 底图：不能关，但点了要有反馈——不做"点了没反应"的节点 */
    $$('#layerTree .tnode.locked').forEach((n) => {
      n.addEventListener('click', () => {
        n.classList.add('shake');
        setTimeout(() => n.classList.remove('shake'), 320);
        const tip = $('#treeNote');
        if (tip) {
          tip.textContent = '底图「NDVI 时序栅格」常开：它是所有叠加层与统计的底，关掉整屏就没有可读的内容了。';
          clearTimeout(n._tipT);
          n._tipT = setTimeout(() => { tip.textContent = treeNoteDefault; }, 3600);
        }
      });
    });
    applyPanel('trend'); applyPanel('treat'); applyPanel('dust'); applyPanel('global');
  }

  /* 组节点后面、下一个组节点之前的全部子节点 */
  function groupChildren(groupEl) {
    const out = [];
    let el = groupEl.nextElementSibling;
    while (el && el.classList.contains('sub')) { out.push(el); el = el.nextElementSibling; }
    return out;
  }

  /* 单个节点开/关；forceOn 为 null 时取反 */
  function toggleTreeNode(el, forceOn) {
    if (el.dataset.layer) {
      const k = el.dataset.layer;
      const on = forceOn == null ? !layers[k] : forceOn;
      layers[k] = on;
      const cb = $(`#mapLayers input[data-layer="${k}"]`);
      if (cb) cb.checked = on;
      paintNode(el, on);
      drawMap();
    } else if (el.dataset.panel) {
      const k = el.dataset.panel;
      const on = forceOn == null ? !panelOn[k] : forceOn;
      panelOn[k] = on;
      paintNode(el, on);
      applyPanel(k);
    }
    paintGroups();                       /* 子节点变了，组节点的三态方框跟着走 */
  }

  function paintNode(el, on) {
    el.classList.toggle('on', !!on);
    const box = el.querySelector('.box');
    if (box) box.textContent = on ? '✓' : '';
  }

  /* 全球对照那张卡的开合 —— 图层树节点、panelOn、卡片显隐**三处必须一起动**。
   * 只改 panelOn 会出现「树上打勾、卡片还藏着」；只改 DOM 会出现「卡片开着、
   * 树上的勾和播完的状态对不上」。导览拿它做节奏控制（见 TOUR 的 panelGlobal）。
   * 导览第 4 步关、第 7 步开，与「默认不勾」是同一条规则，不是三套逻辑。 */
  function setPanelGlobal(on) {
    panelOn.global = !!on;
    applyPanel('global');
    const node = $('#layerTree [data-panel="global"]');
    if (node) { paintNode(node, panelOn.global); paintGroups(); }
  }

  /* 组节点方框三态：全开 ✓ / 全关 空 / 部分 − */
  function paintGroups() {
    $$('#layerTree [data-master]').forEach((n) => {
      const kids = groupChildren(n);
      const on = kids.filter((k) => k.classList.contains('on')).length;
      const box = n.querySelector('.box');
      if (box) box.textContent = on === 0 ? '' : (on === kids.length ? '✓' : '−');
      n.classList.toggle('on', on > 0);
    });
  }

  /* ================= 图表 ================= */
  let charts = [];
  function buildCharts() {
    /* 八张图**全部可拖**（你要的是「拖任意一折线图的白线」）。
     * draggable 让每张都挂命中区 + 方向键；label 只用于 aria 与拖拽提示文案。 */
    /* 先注销旧图：否则重构建（init + resize + load 共三次）会在注册表里
     * 堆到 24 个，其中大半是画在已清空气 DOM 上的废对象。 */
    charts.forEach((c) => c.destroy && c.destroy());
    charts = [
      new C.Chart($('#chNdvi'), { data: MU_SERIES.ndvi, color: '#4ec97a', decimals: 3, tickCount: 4, draggable: true, label: '生长季合成 NDVI' }),
      new C.Chart($('#chCover'), { data: MU_SERIES.cover, color: '#6fe3a2', unit: '%', decimals: 1, tickCount: 4, draggable: true, label: '植被覆盖度' }),
      new C.Chart($('#chNdviCore'), { data: MU_SERIES.ndviCore, color: '#c9b070', decimals: 3, tickCount: 4, draggable: true, label: '基期低植被区 NDVI' }),
      new C.Chart($('#chCoverCore'), { data: MU_SERIES.coverCore, color: '#e0c987', unit: '%', decimals: 1, tickCount: 4, draggable: true, label: '基期低植被区覆盖度估算' }),
      new C.Chart($('#chRate'), { data: MU_SERIES.treatedRate, color: '#6fe3a2', unit: '%', decimals: 1, tickCount: 4, draggable: true, label: '沙化土地治理率示意，非逐年实测' }),
      new C.Chart($('#chDust'), { data: MU_SERIES.dust, color: '#d8b46a', unit: '天', decimals: 0, tickCount: 4, draggable: true, label: '年沙尘日数示意，非逐年实测' }),
      new C.Chart($('#chTreated'), { data: MU_SERIES.treated, color: '#4ec97a', unit: '万亩', decimals: 0, tickCount: 4, draggable: true, label: '累计治理面积示意，非逐年实测' }),
      new C.Chart($('#chSed'), {
        data: MU_SERIES.sediment, color: '#8fa3b0', unit: '亿吨', decimals: 2, tickCount: 4,
        /* 本包缺少这些年份的原始公报，不能绘制实测标记。 */
        observed: [],
        draggable: true, label: '入黄泥沙示意，非逐年实测',
      }),
    ];
    /* 联动游标 → **全站时间**（2026-10-03 升级）。
     * 需求：拖任意一张图的白线，不只是八张图跳到同一年，
     * 而是要「整站统一成一个时间」—— 地图影像、顶栏年份、底部进度条全部跟过去。
     *
     * ⚠ src === null 的分支**必须原样跳过回写**：那是 setYear → drawCharts →
     * setCursor 打回来的回声（src=null）。若这里也 setYear，就是无限递归，
     * 页面会卡死在一帧里 —— 这是本联动最容易踩的坑。
     * 只有 src 为「某张 Chart」时才说明是用户在拖，才回写年份。 */
    if (window.CHARTS && C.onCursor) {
      C.onCursor((i, src) => {
        if (src == null) return;                  /* 程序驱动：不回写，断递归 */
        if (playing) setPlaying(false);            /* 手动拖 = 用户接管，别和自动播放抢年份 */
        setYear(YEARS[i], true);
        const el = $('#panelYear');
        if (el) el.textContent = YEARS[i];
      });
    }
    /* 拖动期的流量策略：40 张高清图共 25 MB，一次快速拖过 40 年就是 25 MB 请求，
     * 而拖动中用户根本看不清细节。所以按下 → 全站切图集预览，松手 → 补当年高清。
     * 键盘微调不算拖拽（一次一年，逐个拉负担得起），由 charts.js 判定。 */
    if (window.CHARTS && C.onDrag) {
      C.onDrag((on) => {
        chartDragging = on;
        if (!on) {
          drawMap();                              /* 松手：把当年高清贴图补上 */
          if (booted) R.preloadYears([year + 1].filter((v) => v <= YEAR_END));
        }
      });
    }
    /* 潼关站五年窗口均值：写进脚注占位符，脚注文案由 data.js 的 note 提供 */
    const sedNote = $('#sedNote'), sedMean = $('#sedWinMean'), sedProse = $('#sedProseMean');
    if (sedMean && MU_US.sediment.window.mean != null) {
      sedMean.textContent = MU_US.sediment.window.mean.toFixed(2);
    }
    if (sedNote && MU_US.sediment.note) sedNote.innerHTML = MU_US.sediment.note;
    /* 正文同一句里的窗口均值也走同一份计算，避免正文与图表脚注各说各的 */
    if (sedProse && MU_US.sediment.window.mean != null) {
      sedProse.textContent = MU_US.sediment.window.mean.toFixed(2);
    }
    C.buildCompareBars($('#cmpBars'));
    /* 必须放在 note 渲染之后：note 里的 <b id="sedWinMean"> 这时才进入 DOM，
     * 先填充后渲染会被 innerHTML 覆盖掉，占位符永远停在「—」。
     * init() 里也调用一次（幂等），覆盖 buildCharts 先于 buildCaveats 的情况。 */
    fillHeadline();
  }

  /* 对外数字统一从 HEADLINE / FACTS_NUM 现算后填进正文占位符。
   * 目的：同一个数字不再在 index.html、CAVEATS、面板脚注里各写一份，
   * 改数据只需改 data.js，正文自动跟着变（这类脱节冒烟测不出来）。
   * 算不出（缺年 / 缺实测）就留「—」，不填默认值。 */
  /* 正文里哪些数字可点开溯源。映射错了比不映射更糟（会给出错误计算链），
   * 所以只登记确实在 TRACES 里查得到链的那几个。 */
  const TRACE_IDS = {
    hlCoreHi: 'core', hlCoreLo: 'core', hlFvcHi: 'fvc', hlFvcLo: 'fvc',
    hlNdviHi: 'ndvi', hlNdviLo: 'ndvi',
    hlModis: 'modis', hlR: 'modis',
    hlGw: 'groundwater',
    sedProseMean: 'sediment', sedWinMean: 'sediment',
  };
  function setTxt(id, v) {
    const el = $('#' + id);
    if (!el || v == null) return;
    el.textContent = v;
    const k = TRACE_IDS[id];
    if (k) { el.classList.add('trace'); el.dataset.trace = k; }
  }

  /* 增量的唯一算法在 data.js（dispDiff：显示端点相减，保证可复算）；
   * 这里只是拿个短名字。 */
  const dispDiff = D.dispDiff;

  function fillHeadline() {
    const H = D.HEADLINE, F = D.FACTS_NUM, f = D.fmtNum;
    if (!H || !F) return;
    setTxt('hlNdviLo', f(H.ndvi[0], 3));
    setTxt('hlNdviHi', f(H.ndvi[1], 3));
    setTxt('hlFvcLo', f(H.fvc[0], 1));
    setTxt('hlFvcHi', f(H.fvc[1], 1));
    setTxt('hlFvcPp', dispDiff(H.fvc[0], H.fvc[1], 1));
    setTxt('hlCoreLo', f(H.fvcCore[0], 1));
    setTxt('hlCoreHi', f(H.fvcCore[1], 1));
    setTxt('hlCorePp', dispDiff(H.fvcCore[0], H.fvcCore[1], 1));
    setTxt('plCoreLo', f(H.fvcCore[0], 1));
    setTxt('plCoreHi', f(H.fvcCore[1], 1));
    setTxt('plCorePp', dispDiff(H.fvcCore[0], H.fvcCore[1], 1));
    setTxt('hlModis', F.modisGrowth);
    setTxt('hlR', F.modisR);
    setTxt('hlGw', F.groundwaterRise);
    setTxt('hlDustFrom', F.dustFrom);
    setTxt('hlDustTo', F.dustTo);
    setTxt('hlSedBase', F.sedBaseline2000s);
    setTxt('hlSedLt', F.sedLongTermMean);
    setTxt('hlSed2025', F.sedYear2025);
    /* CAVEATS 文案里的同名占位符（buildCaveats 之后才存在于 DOM，故在这里补填） */
    setTxt('sedWinMean', H.sedWin != null ? H.sedWin.toFixed(2) : null);
  }

  /* ================= 画布尺寸 ================= */
  function fit(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return false;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    return true;
  }

  /* ================= 渲染 ================= */
  /* 制图网格尺度：必须与 GEE 导出尺度一致（tools/gee_final_series.js 末尾的
   * Export.image.toDrive scale）。标错会被问倒——是多少写多少。 */
  const MAP_GRID = '500 m';

  function drawMap() {
    const cv = $('#muCanvas');
    if (!fit(cv)) return;
    const fastSkip = playing || chartDragging;
    const atlasOnly = fastSkip && !R.realImageLoaded(year);
    R.renderMuUs(cv, year, layers, view, { atlasOnly });
    const kind = R.lastLayerKind();
    const waiting = R.imageState ? R.imageState(year) !== 'ready' : atlasOnly;
    const chip = $('#atlasChip');
    if (chip) {
      chip.hidden = kind === 'real' || kind === 'error';
      chip.textContent = kind === 'loading' ? '正在加载影像'
        : chartDragging ? '播放预览，松手后加载完整图'
        : waiting ? '预览已显示，正在加载完整图' : '降采样预览';
    }
    const meta = $('#mapMeta');
    if (meta) {
      const geo = '37.3°N–39.6°N / 107.3°E–110.6°E';
      meta.textContent = kind === 'real'
        ? 'Landsat · 生长季合成 · 分析尺度500米 · ' + geo
        : kind === 'atlas' ? 'Landsat降采样预览 · 暂停后读取完整导出图 · ' + geo
        : kind === 'error' ? '影像加载失败，可重试；不以模拟画面替代观测'
        : '正在加载Landsat影像 · ' + geo;
    }
    const retry = $('#mapRetry');
    if (retry) retry.hidden = kind !== 'error';
    drawAB();
  }

  function drawGlobals() {
    GLOBALS.forEach((g) => {
      const cv = document.querySelector(`.gp[data-k="${g.key}"] canvas`);
      if (!cv || !fit(cv)) return;
      const ctx = cv.getContext('2d');
      const hit = pickGlobalImg(g.key);
      const badge = document.querySelector(`.gp[data-k="${g.key}"] .gp-src`);
      if (hit) {
        /* 真实影像：直接铺满 canvas。object-fit:cover 的等价做法用 drawImage 裁剪参数实现。 */
        const im = hit.im;
        const ir = im.naturalWidth / im.naturalHeight;
        const cr = cv.width / cv.height;
        let sw = im.naturalWidth, sh = im.naturalHeight, sx = 0, sy = 0;
        if (ir > cr) { sw = im.naturalHeight * cr; sx = (im.naturalWidth - sw) / 2; }
        else { sh = im.naturalWidth / cr; sy = (im.naturalHeight - sh) / 2; }
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.drawImage(im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        R.vignette(cv, 0.34);
        if (badge) {
          badge.textContent = '真实影像 · Landsat 5 · ' + hit.y;
          badge.className = 'gp-src real';
        }
      } else {
        g.fn(cv, year);
        R.vignette(cv, 0.46);
        if (badge) {
          badge.textContent = '示意图 · 程序化合成';
          badge.className = 'gp-src synth';
          badge.title = '真实卫星影像尚未就位（GEE 导出后自动替换）';
        }
      }
      const arr = GLOBAL_SERIES[g.src];
      const i = year - YEAR_START;
      const v = arr[i], v0 = arr[0], vN = arr[Y0];
      const u = g.bad === 'shrink' ? 1 - v / v0 : (v - v0) / (vN - v0 || 1);
      const box = cv.closest('.gp');
      box.querySelector('.gp-val').textContent = `${v.toFixed(D.GLOBAL[g.src].decimals)} ${D.GLOBAL[g.src].unit}`;
      box.querySelector('.gp-bar i').style.width = `${Math.max(2, Math.min(100, u * 100))}%`;
    });
  }

  function drawStats() {
    const i = year - YEAR_START;
    $$('#statRow .stat').forEach((el, k) => {
      const stat = STATS[k], values = MU_SERIES[stat.key];
      const value = values[i], delta = value - values[0];
      el.querySelector('.num').textContent = value.toFixed(stat.dec);
      const difference = el.querySelector('.d');
      if (year === YEAR_START) {
        difference.className = 'd';
        difference.textContent = '起点年';
      } else {
        const better = stat.good === 'down' ? delta <= 0 : delta >= 0;
        difference.className = 'd ' + (better ? 'up' : 'down');
        difference.textContent = (delta >= 0 ? '▲ ' : '▼ ') + Math.abs(delta).toFixed(stat.dec) + ' · 比 ' + YEAR_START + ' 年';
      }
    });
    const cover = $('#gfCover');
    if (cover) cover.textContent = MU_SERIES.cover[i].toFixed(1) + '%';
    const note = $('#mapNote');
    if (note) note.textContent = year + ' 年 · ' + mapNoteFor(year);
  }

  function drawCharts() {
    const i = year - YEAR_START;
    /* 走 CHARTS.setCursor 而不是直接 forEach(setIndex)：
     * 这样「游标真身」CUR 也跟着时间轴走，否则时间轴拖到 2010、CUR 还停在旧值，
     * 用户再轻轻一拖，八条线会突然跳一下（实测过才发现的）。顺带把面板年份也刷新了。 */
    if (C && C.setCursor) C.setCursor(i);
    else charts.forEach((c) => c.setIndex(i));
  }

  /* ==================================================================
   * 批次 2：导览模式 + URL 状态 + 键盘（三者共用一套状态）
   * ------------------------------------------------------------------
   * 为什么合并：导览每一步本就要「滚到某屏 + 设某年 + 可能开分屏」，
   * 而 URL 要分享的正是这套状态。分开写会把同一份状态同步逻辑抄两遍。
   * ================================================================== */

  /* ---- 文案占位符：{token} 一律现算，不写死 ---- */
    const HEAD = D.HEADLINE, FN = D.FACTS_NUM, W = D.WIN;
    /* 导览文案里的 {corePp} 等占位与正文同一算法（显示端点相减），保证可复算 */
    const pp = (p, dec) => dispDiff(p[0], p[1], dec == null ? 1 : dec);
    const TOK = {
      y0: String(YEAR_START), y1: String(YEAR_END), n: String(YEARS.length),
      winLo: `${W.lo[0]}—${W.lo[1]}`, winHi: `${W.hi[0]}—${W.hi[1]}`,
      coreLo: D.fmtNum(HEAD.fvcCore[0], 1), coreHi: D.fmtNum(HEAD.fvcCore[1], 1), corePp: pp(HEAD.fvcCore),
      fvcLo: D.fmtNum(HEAD.fvc[0], 1), fvcHi: D.fmtNum(HEAD.fvc[1], 1), fvcPp: pp(HEAD.fvc),
    ndviLo: D.fmtNum(HEAD.ndvi[0], 3), ndviHi: D.fmtNum(HEAD.ndvi[1], 3),
    modis: D.fmtNum(FN.modisGrowth, 0), r: D.fmtNum(FN.modisR, 2),
    gw: String(FN.groundwaterRise), dustFrom: String(FN.dustFrom), dustTo: String(FN.dustTo),
    sedWin: D.fmtNum(HEAD.sedWin, 2),
  };
  const tourText = (s) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => (k in TOK ? TOK[k] : m));

  /* ---- URL 状态：?year=&layers=&ab=&tour= ---- */
  const LAYER_DEFAULT = JSON.stringify(layers);
  let urlTimer = null;

    function writeURL() {
      if (playing) return;            /* 播放中不写：40 次/秒会把 replaceState 打爆 */
      if (location.protocol === 'file:') return;   /* file:// 不接受带 query 的 replaceState；站点本就要求 http（canvas 污染） */
      const p = new URLSearchParams(location.search);
      ['year', 'layers', 'ab', 'tour'].forEach(key => p.delete(key));
    p.set('year', String(year));
    if (JSON.stringify(layers) !== LAYER_DEFAULT) {
      p.set('layers', Object.keys(layers).filter((k) => layers[k]).join(','));
    }
    if (ab.on) p.set('ab', String(ab.y));
    if (tour.on) p.set('tour', String(tour.i + 1) + (tour.auto ? 'a' : ''));
    history.replaceState(null, '', location.pathname + '?' + p.toString() + location.hash);
  }
  function syncURL() {                   /* 防抖：连续改变只落一次 */
    clearTimeout(urlTimer);
    urlTimer = setTimeout(writeURL, 350);
  }
  function setLayer(k, on) {
    if (!(k in layers) || layers[k] === on) return;
    layers[k] = on;
    const n = document.querySelector(`#layerTree [data-layer="${k}"]`);
    if (n) paintNode(n, on);
    const cb = document.querySelector(`#mapLayers input[data-layer="${k}"]`);
    if (cb) cb.checked = on;
    paintGroups();                       /* 子节点变了，组节点的三态方框要跟着走 */
    drawMap();
  }

  /* ---- 导览状态机 ---- */
  const tour = { on: false, i: 0, auto: false, timer: null };

  function renderTourUI(st) {
    $('#tourIdx').textContent = String(tour.i + 1);
    $('#tourTotal').textContent = String(TOUR.length);
    $('#tourTitle').textContent = tourText(st.t);
    $('#tourSub').textContent = tourText(st.s || '');
    $('#tourBody').textContent = tourText(st.d || '');
    $('#tourTip').textContent = tourText(st.tip || '');
    $('#tourDots').innerHTML = TOUR.map((_, i) => `<i class="${i === tour.i ? 'on' : ''}"></i>`).join('');
    $('#tourPrev').disabled = tour.i === 0;
    $('#tourNext').textContent = tour.i === TOUR.length - 1 ? '结束' : '下一步 →';
    const a = $('#tourAuto');
    a.textContent = tour.auto ? '自动播放中 ⏸' : '自动播放 ▶';
    a.setAttribute('aria-pressed', tour.auto ? 'true' : 'false');
    a.classList.toggle('on', tour.auto);
  }

  /* 自动播放：本步停够时间就前进。交互式操作（手动上/下一步）会关掉自动。 */
  function armAuto() {
    clearTimeout(tour.timer);
    const st = TOUR[tour.i];
    if (!tour.on || !tour.auto) return;
    /* 这一屏要自动播放时间轴时，停留时长**不得短于走完 40 年**（40 × playMs）：
     * 否则播放会在半路被下一跳掐断（200 ms/年就是走到 2019 年突然切走，
     * 观感是「年份跳了一下」，比不播还糟）。所以取 max(你给的 hold, 播放耗时) ——
     * 你给的 hold 是下界不是硬值。第 5 步 7000 → 实际 8000，就差在这。 */
    const hold = (st.play && st.hold)
      ? Math.max(st.hold, (YEAR_END - YEAR_START + 1) * DEV.playMs)
      : (st.hold || 8000);
    tour.timer = setTimeout(() => {
      if (tour.on && tour.auto) goStep(tour.i + 1);
    }, hold);
  }
  /* 导览翻页落点。
   * 旧写法 el.scrollIntoView({ block: 'start' }) 把目标顶边贴到视口 y=0，
   * 而 .nav 是 56px 的**固定**顶栏 —— 于是卡片最上面 56px 正好藏进导航底下，
   * 页面整体位置也偏下（实测第 5 步 .insight-card：cardTop=0、cardBottom=445）。
   * 改成「顶边对齐到导航下沿再留 16px 呼吸」，目标整块可见，页面同时往上收一点。 */
  const NAV_GAP = 16;
  function scrollUnderNav(el) {
    const nav = document.querySelector('.nav');
    const navH = nav ? nav.offsetHeight : 0;
    const docTop = el.getBoundingClientRect().top + window.scrollY;
    const top = Math.max(0, Math.round(docTop - navH - NAV_GAP));
    window.scrollTo({ top, behavior: 'smooth' });
  }

  /* ======================================================================
   * 导览落点解析 —— 支持两种来源
   * ------------------------------------------------------------------
   * 原来只有一种：st.sec（选择器），落点 = 元素顶边贴导航下沿。
   * 现在多了第二种：st.at（**手动设定的落点**），优先级更高。
   *
   * st.at 的结构（由开发者面板生成，见 devTools）：
   *   { y: 绝对滚动像素, a: '锚点选择器', o: 锚点相对视口的偏移 }
   * 只存绝对像素不顶用 —— 换屏幕高度就偏了。所以同时记一个**视口内的元素锚点**
   * （离视口顶最近的那个有 id 或 class 的容器），回放时优先用锚点定位，
   * 锚点找不到才退回绝对像素。这样同一份配置在不同屏幕上大致都能复现。
   */
  function resolveStepScroll(st) {
    if (st.at && typeof st.at.y === 'number') {
      const o = typeof st.at.o === 'number' ? st.at.o : 0;
      const a = st.at.a ? $(st.at.a) : null;
      if (a) {
        /* 有锚点：按「顶边贴导航下沿 + 视口偏移」定位，换屏幕高度也不会漂 */
        const nav = document.querySelector('.nav');
        const navH = nav ? nav.offsetHeight : 0;
        const docTop = a.getBoundingClientRect().top + window.scrollY;
        return Math.max(0, Math.round(docTop - navH - NAV_GAP + o));
      }
      /* 没有锚点（你已经调准了绝对落点）：o 是落点微调，直接叠在绝对像素上。
       * 不能在这里丢掉 o —— 早先丢过，你按 JSON 给的 -2 / +4 这些微调就全失效了。 */
      return Math.max(0, Math.round(st.at.y + o));
    }
    if (st.sec) {
      const el = $(st.sec);
      if (el) {
        const nav = document.querySelector('.nav');
        const navH = nav ? nav.offsetHeight : 0;
        const docTop = el.getBoundingClientRect().top + window.scrollY;
        return Math.max(0, Math.round(docTop - navH - NAV_GAP));
      }
    }
    return null;
  }

  function scrollToStep(st) {
    const top = resolveStepScroll(st);
    if (top != null) window.scrollTo({ top, behavior: 'smooth' });
  }

  function goStep(i) {
    if (i >= TOUR.length) { endTour(); return; }
    tour.i = Math.max(0, i);
    const st = TOUR[tour.i];
    autoDone = true;                       /* 导览自己控制播放，别让首屏自动播插一脚 */

    scrollToStep(st);
    setPlaying(false);                     /* 换步先收声，下一步要播自己会开 */
    if (st.year === 'start') setYear(YEAR_START, true);
    else if (st.year === 'end') setYear(YEAR_END, true);
    if (st.ab != null) {
      ab.on = true; ab.y = st.ab;
      const t = $('#abToggle'); if (t) t.checked = true;
      const r = $('#abRange'); if (r) { r.value = st.ab; }
      const y = $('#abYear'); if (y) y.textContent = st.ab;
      drawAB();
    }
    /* 导览节奏控制：这一屏要不要把右栏那张全球对照请上来。
     * 只有 TOUR 里显式写了 panelGlobal 的步才动它 —— 用户自己勾的，
     * 别在别的步里被悄悄改掉（「我看了一眼顺手勾上，翻一页它自己没了」是典型的坏体验）。 */
    if (st.panelGlobal != null) setPanelGlobal(st.panelGlobal);
    if (st.trace) setTimeout(() => openTrace(st.trace), 900);

    renderTourUI(st);
    syncURL();
    if (st.play) {
      /* 这一屏要播时间轴 → **必须回到 1986 重新走起**。
       *
       * 你实测到的「第 5 步 / 第 7 步不自动播」就是这个原因：上一步播完停在 2025，
       * 这里直接 setPlaying(true)，setInterval 第一帧就撞上 `year >= YEAR_END`
       * 立刻自停 —— 看着像压根没播，其实是在终点原地停了一步。
       * 所以进 play 步先 setYear(YEAR_START)（silent=true：这一次定位不额外拉高清），
       * 再等图集就位开播。
       *
       * 条件里的 `year === YEAR_START` 是给用户留的口子：图集还没好的这一会儿
       * 用户自己把年份拖走了（或手动翻了下一步），就别自作主张把他的年份抢回来重播。 */
      setYear(YEAR_START, true);
      /* 播放靠图集层兜底（否则大多数年份会退化成程序化合成图），等图集就位再开播 */
      R.onProbeCubeReady(() => {
        if (tour.on && TOUR[tour.i].play && year === YEAR_START) setPlaying(true);
      });
    }
    armAuto();
  }

  function startTour(i) {
    tour.on = true;
    tour.auto = true;
    document.body.classList.add('touring');
    $('#tour').hidden = false;
    goStep(i || 0);
  }
  function endTour() {
    tour.on = false; tour.auto = false;
    clearTimeout(tour.timer);
    setPlaying(false);
    closeTrace();
    document.body.classList.remove('touring');
    $('#tour').hidden = true;
    syncURL();
  }
  /* 手动翻步 = 我要自己控制，关掉自动 */
  function manualStep(d) {
    tour.auto = false;
    clearTimeout(tour.timer);
    goStep(tour.i + d);
    if (tour.on) armAuto();
  }
  function toggleAuto() {
    tour.auto = !tour.auto;
    renderTourUI(TOUR[tour.i]);
    if (tour.auto) goStep(tour.i);   /* 重走本步：重新计时并应用本步动作 */
    else clearTimeout(tour.timer);
  }

  /* ---- 读 URL 并应用（放在 init 末尾调用，此时上位变量都已就绪） ---- */
  function readURL() {
    const p = new URLSearchParams(location.search);
    const ls = p.get('layers');
    if (ls != null) {
      Object.keys(layers).forEach((k) => setLayer(k, ls.split(',').indexOf(k) >= 0));
    }
    const y = parseInt(p.get('year'), 10);
    if (isFinite(y)) setYear(y, true);
    const abv = p.get('ab');
    if (abv != null && /^\d+$/.test(abv)) {
      ab.on = true; ab.y = Math.max(YEAR_START, Math.min(YEAR_END, parseInt(abv, 10)));
      const t = $('#abToggle'); if (t) t.checked = true;
      const r = $('#abRange'); if (r) r.value = ab.y;
      const yl = $('#abYear'); if (yl) yl.textContent = ab.y;
      drawAB();
    }
    const tv = p.get('tour');
    if (tv != null && !window.NARRATIVE) {
      const n = parseInt(tv, 10);
      startTour(isFinite(n) && n >= 1 ? n - 1 : 0);
      if (!/a$/.test(tv)) { tour.auto = false; clearTimeout(tour.timer); renderTourUI(TOUR[tour.i]); }
    }
  }

  /* 浏览器前进/后退：重新读一遍 URL（replaceState 不触发 popstate，不会自激） */
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    const y = parseInt(p.get('year'), 10);
    if (isFinite(y) && y !== year) setYear(y, true);
    if (!p.get('tour') && tour.on) endTour();
  });

  function setYear(y, silent, origin = 'manual') {
    if (typeof y !== 'number' || !Number.isFinite(y)) return;
    year = Math.max(YEAR_START, Math.min(YEAR_END, Math.round(y)));
    $('#tlYear').textContent = year;
    $('#navYear').textContent = year;
    $('#mapYear').textContent = year;
    $('#panelYear').textContent = year;
    const r = $('#tlRange');
    if (+r.value !== year) r.value = year;
    $$('#tlMarks i').forEach((m) => m.classList.toggle('hit', +m.dataset.y <= year));
    const ms = MILESTONES.filter((m) => m.year <= year).pop();
    const near = MILESTONES.find((m) => m.year === year);
    const phase = (D.PHASES || []).find((p) => year >= p.start && year <= p.end);
    $('#tlTip').textContent = near ? year + ' · ' + near.title
      : phase ? phase.start + '—' + phase.end + ' · ' + phase.name : String(year);
    drawMap(); drawGlobals(); drawStats(); drawCharts();
    /* 预取策略（实测调过，别凭感觉改）：
     * - 播放中**不预取**高清：播放走图集层，40 年只花 1.5 MB，
     *   此时拉高清纯属浪费（5.4 秒播完 vs 4G 下 48 秒才下得完）。
     * - 拖图中同理：一次拖过 40 年逐年预取 = 主动把 25 MB 拉下来。
     *   停在哪一年由 onDrag(false) 统一补，别在拖动过程中预取。
     * - 手动切换年份才预取相邻两年，让单步浏览是顺的。
     * - 首屏（booted=false）不预取，保证打开页面只下载 1 张。 */
    if (booted && !playing && !chartDragging && !silent) {
      R.preloadYears([year + 1].filter((v) => v <= YEAR_END));
    }
    if (booted) syncURL();
    window.dispatchEvent(new CustomEvent('mu:year', { detail: { year, origin } }));
  }

  /* ================= 交互层 C1：缩放平移 ================= */
  const view = { s: 1, x: 0, y: 0 };
  const MIN_S = 1, MAX_S = 8;

  /* 变换是 translate(x,y) + scale(s,s)，底图按 (0,0,cw,ch) 绘制，
   * 故要让画面始终铺满画布，x ∈ [cw(1−s), 0]、y 同理。 */
  function clampView(cv) {
    view.x = Math.min(0, Math.max(cv.width * (1 - view.s), view.x));
    view.y = Math.min(0, Math.max(cv.height * (1 - view.s), view.y));
  }
  function dprOf(cv) {
    const r = cv.getBoundingClientRect();
    return r.width ? cv.width / r.width : 1;
  }
  function updateZoomHint() {
    const h = $('#zoomHint');
    if (h) h.textContent = view.s > 1.001 ? `缩放 ${view.s.toFixed(1)}× · 双击复位` : '滚轮缩放 · 拖动平移';
  }
  /* 复位视图（双击地图 / 点缩放提示）。此前 dblclick 调了 resetView() 但全工程没有这个函数
   * —— 「双击复位」一直报 ReferenceError、点了没反应，是真 bug 而非没人用的死代码。 */
  function resetView() {
    view.s = 1; view.x = 0; view.y = 0;
  }

  /* ================= 交互层 C2：点查逐年曲线 ================= */
  /* 与 tools/ndvi_palette.py 同一条色带：GEE visualize({min:0,max:0.7})
   * 在 7 个色标之间线性插值。像素颜色 -> 最近色带索引 -> NDVI。 */
  const RAMP_STOPS = [[138, 108, 72], [201, 174, 113], [217, 197, 127],
    [178, 193, 117], [124, 168, 91], [74, 139, 73], [40, 105, 58]];
  const RAMP_TABLE = (function () {
    const out = [];
    for (let i = 0; i < 255; i++) {
      const u = (i / 254) * (RAMP_STOPS.length - 1);
      const k = Math.min(RAMP_STOPS.length - 2, Math.floor(u));
      const f = u - k;
      out.push([0, 1, 2].map((c) => Math.round(
        RAMP_STOPS[k][c] + (RAMP_STOPS[k + 1][c] - RAMP_STOPS[k][c]) * f)));
    }
    return out;
  })();

  function rgbToNdvi(r, g, b) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < RAMP_TABLE.length; i++) {
      const c = RAMP_TABLE[i];
      const d = (c[0] - r) * (c[0] - r) + (c[1] - g) * (c[1] - g) + (c[2] - b) * (c[2] - b);
      if (d < bd) { bd = d; best = i; }
    }
    return best / 254 * 0.7;
  }

  /* 取该逻辑点在 1986—2025 每一年贴图上的色带反解值；空值返回 null */
  /* 点查走「图集」而不是逐年拉贴图。
   * 旧实现每年调一次 tryRealImage()，等于把 40 张 1100x772 的 PNG 全下下来
   * （实测 23.9 MB，4G 约 9 秒）——而点查需要的只是每个网格单元一个值。
   * 图集 probe_cube.png 是同一批贴图降采样成的 40 层 264x184 网格，约 1.5 MB，
   * 一次性进内存后，点查变成纯查表。生成与核验见 tools/make_probe_cube.py。 */
  function seriesAtPoint(cv, cx, cy) {
    const cube = R.probeCube();
    if (!cube) return null;                       /* 未就绪：交给调用方明确提示 */
    const G = R.PROBE_GRID;
    const gx = Math.min(G.w - 1, Math.max(0, Math.floor((cx / cv.width) * G.w)));
    const gy = Math.min(G.h - 1, Math.max(0, Math.floor((cy / cv.height) * G.h)));
    const aw = G.cols * G.w;
    const out = [];
    for (let y = YEAR_START; y <= YEAR_END; y++) {
      const k = y - YEAR_START;
      const r = Math.floor(k / G.cols), c = k % G.cols;
      const o = ((r * G.h + gy) * aw + (c * G.w + gx)) * 4;
      out.push(cube[o + 3] === 0 ? null : rgbToNdvi(cube[o], cube[o + 1], cube[o + 2]));
    }
    return out;
  }

  /* C2 点查曲线 —— 三条硬约束，缺一条用户就会把"单点噪声"读成"数据崩了"：
   * 1) y 轴与区域 NDVI 曲线（charts[0]，全区均值）**取同一量程**，不按本点自适应。
   *    自适应每次点击都重设量程，把单点 ±0.15 的抖动放大成"暴跌/暴涨"；
   *    同量程则单点曲线与区域曲线可直接比较，抖动的量级一眼就看得出是局部噪声。
   *    超出该量程的年份**钳制在边框**并在脚注计数，不静默截断；
   * 2) 无观测年份（云掩膜后该单元当年 0 景有效）用虚线桥接并在脚注计数，不静默跳过；
   * 3) 标题显式写"非区域均值"，与区域均值口径分开。 */
  const PROBE_TOP = 12, PROBE_BOT = 58, PROBE_L = 15, PROBE_R = 5;

  let probePending = null;
  function renderProbe(cx, cy) {
    const cv = $('#muCanvas');
    const ser = seriesAtPoint(cv, cx, cy);
    const box = $('#probe');
    /* 图集还没就位：明确告诉用户「在准备」，加载完自动补画，不静默空着 */
    if (!ser) {
      probePending = [cx, cy];
      box.hidden = false;
      $('#probeChart').innerHTML = '';
      $('#probeRetry').hidden = true;
      $('#probeTitle').textContent = '网格单元着色近似值（非区域均值）';
      $('#probeFoot').textContent = '点查数据准备中…（约 1.5 MB，只需一次）';
      R.onProbeCubeReady((ok) => {
        if (!ok) {
          $('#probeFoot').textContent = '点查图集未能加载，请重试。';
          $('#probeRetry').hidden = false;
          return;
        }
        if (probePending) renderProbe(probePending[0], probePending[1]);
      });
      return;
    }
    probePending = null;
    $('#probeRetry').hidden = true;
    /* 量程来源唯一：区域曲线实例自己算出来的 mn/mx。拿不到就不画（禁静默兜底）。 */
    const reg = charts[0];
    if (!reg || reg.mn == null || reg.mx == null || !(reg.mx > reg.mn)) {
      $('#probeTitle').textContent = '网格单元着色近似值（非区域均值）';
      $('#probeFoot').textContent = '区域曲线量程未就绪，无法按同标尺绘制';
      box.hidden = false;
      return;
    }
    const lo = reg.mn, hi = reg.mx;
    const sx = (i) => PROBE_L + i / (YEAR_END - YEAR_START) * (240 - PROBE_L - PROBE_R);
    const rawY = (v) => PROBE_BOT - ((v - lo) / (hi - lo)) * (PROBE_BOT - PROBE_TOP);
    const sy = (v) => Math.min(PROBE_BOT, Math.max(PROBE_TOP, rawY(v)));

    const idx = [];
    ser.forEach((v, i) => { if (v !== null) idx.push(i); });
    if (!idx.length) { box.hidden = true; return; }
    const plo = Math.min(...idx.map((i) => ser[i]));
    const phi = Math.max(...idx.map((i) => ser[i]));
    const gapCount = ser.length - idx.length;
    const overCount = idx.filter((i) => ser[i] > hi || ser[i] < lo).length;

    /* 连续有观测 → 实线；跨越了无观测年份 → 虚线桥接（不假装数据连续） */
    let solid = '', bridge = '', lp = null, lpIdx = -1;
    idx.forEach((i) => {
      const px = sx(i), py = sy(ser[i]);
      if (lp === null) solid += `M${px.toFixed(1)},${py.toFixed(1)}`;
      else if (i - lpIdx > 1) bridge += `M${lp.x.toFixed(1)},${lp.y.toFixed(1)}L${px.toFixed(1)},${py.toFixed(1)}`;
      else solid += `L${px.toFixed(1)},${py.toFixed(1)}`;
      lp = { x: px, y: py }; lpIdx = i;
    });

    const cur = ser[year - YEAR_START];
    $('#probeChart').innerHTML =
      `<path d="${solid}" fill="none" stroke="#3f7d52" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`
      + `<path d="${bridge}" fill="none" stroke="#3f7d52" stroke-width="1.2" stroke-dasharray="2.5 2.5" opacity=".6"/>`
      + `<line x1="${PROBE_L}" y1="${PROBE_TOP}" x2="235" y2="${PROBE_TOP}" stroke="rgba(255,255,255,.14)"/>`
      + `<line x1="${PROBE_L}" y1="${PROBE_BOT}" x2="235" y2="${PROBE_BOT}" stroke="rgba(255,255,255,.14)"/>`
      + `<text x="${PROBE_L - 3}" y="${PROBE_TOP + 3}" font-size="6.5" fill="#7c8b84" text-anchor="end">${hi.toFixed(2)}</text>`
      + `<text x="${PROBE_L - 3}" y="${PROBE_BOT + 3}" font-size="6.5" fill="#7c8b84" text-anchor="end">${lo.toFixed(2)}</text>`
      + `<text x="6" y="${PROBE_BOT + 13}" font-size="6.5" fill="#7c8b84">${YEAR_START}</text>`
      + `<text x="234" y="${PROBE_BOT + 13}" font-size="6.5" fill="#7c8b84" text-anchor="end">${YEAR_END}</text>`
      + (cur === null ? '' : `<circle cx="${sx(year - YEAR_START).toFixed(1)}" cy="${sy(cur).toFixed(1)}" r="3.2" fill="#e2483c" stroke="#fff" stroke-width="1.2"/>`);

    const gapTxt = gapCount ? ` · <b>${gapCount} 年无观测</b>（曲线中虚线段）` : '';
    const overTxt = overCount ? ` · <b>${overCount} 年超出区域量程</b>（已压在边框上）` : '';
    $('#probeTitle').textContent = `网格单元着色近似值 · ${year}`;
    $('#probeFoot').innerHTML = cur === null
      ? `该点当年<b>无有效观测</b>${gapTxt}${overTxt} · 本点全序列 <b>${plo.toFixed(3)}—${phi.toFixed(3)}</b>`
      : `该年近似 <b>${cur.toFixed(3)}</b>${gapTxt}${overTxt} · 本点全序列 <b>${plo.toFixed(3)}—${phi.toFixed(3)}</b>`
        + `<br><span class="probe-ctx">与区域 NDVI 曲线<b>同一量程 ${lo.toFixed(3)}—${hi.toFixed(3)}</b>（不随点击自适应）；`
        + `全站结论仍取区域五年窗口均值 ${D.fmtNum(D.HEADLINE.ndvi[0])} → ${D.fmtNum(D.HEADLINE.ndvi[1])}</span>`;
    box.hidden = false;
  }

  /* ================= 交互层 C3：A/B 分屏对比 ================= */
  /* A = 时间轴当前年份（底层主图），B = 叠加层上另一年份，中间可拖动分隔线。
   * B 年可选 1986—2025 任一单年：这是全站时间轴逐年贴图的一部分，
   * 与 C1/C2 一样只作画面对比，图上不写值，结论数字仍取五年窗口 headline。 */
  /* 对比年 B 默认 YEAR_START：A/B 分屏的价值在于「同一个地方、两个年份」，
     默认 2025 会让它变成把同一张图放两遍，等于没有对比。 */
  const ab = { on: false, y: YEAR_END, split: 0.5 };

  function drawAB() {
    const cv = $('#abCanvas');
    if (!cv || !fit(cv)) return;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const label = $('#abLabel');
    if (label) label.textContent = ab.on ? `${year} ▸ ${ab.y}` : '';
    if (!ab.on) return;
    const b = R.tryRealImage(ab.y);
    if (!b) return;

    const cw = cv.width, ch = cv.height;
    const splitX = cw * ab.split;
    ctx.save();
    ctx.beginPath(); ctx.rect(splitX, 0, cw - splitX, ch); ctx.clip();
    if (view.s !== 1 || view.x || view.y) { ctx.translate(view.x, view.y); ctx.scale(view.s, view.s); }
    ctx.drawImage(b, 0, 0, cw, ch);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, ch); ctx.stroke();
    ctx.fillStyle = 'rgba(226,72,60,.92)';
    ctx.beginPath(); ctx.arc(splitX, ch / 2, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.arc(splitX, ch / 2, 3, 0, Math.PI * 2); ctx.fill();
    /* 年份标签：贴在**中缝两侧**，左边标 A 年、右边标 B 年。
     *
     * 为什么不用四角：这张卡片四个角都被 HTML 占了 —— 左上「滚轮缩放·拖动平移」
     * 提示条、右上 .year-chip 年份胶囊、左下 NDVI 图例、右下（窄屏时）图例换行。
     * 标签画在角上会被盖住，看上去像"分屏没标年份"。中缝上下是空的，
     * 而且贴在中缝两侧读起来最直白：左边是什么年、右边是什么年。
     * 字号随 dpr 走，否则高缩放下标签会糊成一条线。 */
    const d = (cv.width / cv.clientWidth) || 1;
    ctx.font = `600 ${Math.round(13 * d)}px "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'middle';
    const pad = 10 * d, tw = 62 * d, th = 24 * d, gap = 8 * d;
    const tx0 = Math.max(pad, splitX - gap - tw);   // A 年：贴中缝左侧
    const tx1 = Math.min(cw - pad - tw, splitX + gap);  // B 年：贴中缝右侧
    ctx.fillStyle = 'rgba(6,14,11,.72)';
    ctx.fillRect(tx0, pad, tw, th);
    ctx.fillRect(tx1, pad, tw, th);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(String(year), tx0 + tw / 2, pad + th / 2);
    ctx.fillText(String(ab.y), tx1 + tw / 2, pad + th / 2);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  function bindMapInteractions() {
    const cv = $('#muCanvas');
    cv.style.cursor = 'grab';
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect(), d = dprOf(cv);
      const mx = (e.clientX - r.left) * d, my = (e.clientY - r.top) * d;
      const s0 = view.s;
      const s1 = Math.max(MIN_S, Math.min(MAX_S, s0 * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
      if (s1 === s0) return;
      view.x = mx - (mx - view.x) * (s1 / s0);
      view.y = my - (my - view.y) * (s1 / s0);
      view.s = s1;
      clampView(cv); updateZoomHint(); drawMap();
    }, { passive: false });

    let drag = null, splitDrag = false;
    cv.addEventListener('pointerdown', (e) => {
      const r = cv.getBoundingClientRect();
      if (ab.on && Math.abs((e.clientX - r.left) - cv.clientWidth * ab.split) < 16) {
        splitDrag = true;
        cv.setPointerCapture(e.pointerId);
        cv.style.cursor = 'ew-resize';
        return;
      }
      /* 不能因为「当前未放大」就 return：那样 drag 恒为 null，pointerup 会直接跳过，
       * 结果是默认视图下点击地图完全触发不了点查（必须先滚轮放大才能点）——
       * 实测踩到过。平移在 s=1 时会被 clampView 归零，本身没有副作用，
       * 所以这里一律记录起点，把「算平移还是算点击」的判断交给 pointerup。 */
      if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: 0 };
      cv.style.cursor = 'grabbing';
    });
    cv.addEventListener('pointermove', (e) => {
      if (splitDrag) {
        const r = cv.getBoundingClientRect();
        ab.split = Math.min(0.92, Math.max(0.08, (e.clientX - r.left) / (r.width || 1)));
        drawAB();
        return;
      }
      if (!drag) return;
      const d = dprOf(cv);
      const dx = (e.clientX - drag.x) * d, dy = (e.clientY - drag.y) * d;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      view.x = drag.vx + dx; view.y = drag.vy + dy;
      clampView(cv); drawMap();
    });
    cv.addEventListener('pointerup', (e) => {
      if (splitDrag) { splitDrag = false; cv.style.cursor = 'grab'; return; }
      if (!drag) return;
      const moved = drag.moved; drag = null;
      cv.style.cursor = 'grab';
      if (moved < 5) probeAt(e);          /* 位移极小才算点击，避免与平移混淆 */
    });
    cv.addEventListener('dblclick', () => { resetView(); updateZoomHint(); drawMap(); });

    function probeAt(e) {
      const r = cv.getBoundingClientRect(), d = dprOf(cv);
      const cx = (e.clientX - r.left) * d, cy = (e.clientY - r.top) * d;
      renderProbe((cx - view.x) / view.s, (cy - view.y) / view.s);
    }
    const close = $('#probeClose');
    if (close) close.addEventListener('click', () => { $('#probe').hidden = true; });
    $('#probeRetry').addEventListener('click', () => {
      if (!probePending) return;
      R.retryProbeCube();
      renderProbe(probePending[0], probePending[1]);
    });
  }

  /* ================= 时间轴控制 ================= */
  const PLAY_ICON = { play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z' };
  /* 播放状态有**两个**入口：吸底时间轴的播放键（#tlPlay）和顶栏年份胶囊左边的
   * 「时间轴行进」开关（#panelPlay）。两个键必须显示同一份状态 —— 否则用户会看到
   * 「一个显示暂停、一个显示播放」，而实际状态只有一个，那是典型的界面撒谎。
   * 所以图标刷新集中在这里，两个键都不自己管自己的图标。 */
  function paintPlayState() {
    const icon = playing ? PLAY_ICON.pause : PLAY_ICON.play;
    const pi = $('#playIcon'), pp = $('#panelPlayIcon');
    if (pi) pi.setAttribute('d', icon);
    if (pp) pp.setAttribute('d', icon);
    const btn = $('#panelPlay');
    if (btn) {
      btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
      const t = btn.querySelector('.sp-txt');
      if (t) t.textContent = playing ? '暂停行进' : '时间轴行进';
      btn.setAttribute('aria-label', playing ? '暂停时间轴行进' : '开始时间轴行进');
    }
  }
  function setPlaying(p) {
    playing = p;
    paintPlayState();
    clearInterval(playTimer);
    if (!p) {
      /* 停止播放：把当前这一年的高清贴图补上（播放期间刻意没拉，省了 23.9 MB） */
      drawMap();
      /* 播放期 writeURL 是跳过的（不然 40 次/秒会把 replaceState 打爆），
       * 所以停下必须补写一次，否则 URL 会永远停在起播那一年。 */
      syncURL();
      return;
    }
    if (p) {
      /* 每帧毫秒：默认 DEV.playMs（现在是 200 → 40 年 8.0 s，导览第 4 步文案「压进十秒」
       * 就按这个数排的；之前是 135 → 5.4 s）。开发者面板可临时覆盖（存 localStorage，
       * 不污染代码）。覆盖值在 devTools.reset() 里能一键清掉。 */
      playTimer = setInterval(() => {
        if (year >= YEAR_END) { setPlaying(false); return; }
        setYear(year + 1);
      }, DEV.playMs);
    }
  }

  /* ================= 首屏动画 ================= */
  /* 首屏角标如实标注这一屏画的是什么：程序化合成绝不允许被标成「真实影像」。
   * 这是红线 12（禁止静默 fallback）在视觉层的落地 —— 角标文本由渲染器返回值决定，
   * 不做默认值兜底。 */
  const HERO_TAGS = {
    real: '底图 · 1986 年 Landsat 真实影像',
    synth: '底图 · 程序化合成（影像未加载）',
  };
  let heroVisible = true, heroRAF = null, ht = 0;
  function heroLoop() {
    const cv = $('#heroCanvas');
    if (!fit(cv)) { heroRAF = requestAnimationFrame(heroLoop); return; }
    ht += 0.008;
    const kind = R.renderHero(cv, ht);
    const tag = $('#heroTag');
    if (tag && tag.dataset.kind !== kind) {
      tag.dataset.kind = kind;
      tag.textContent = HERO_TAGS[kind] || '';
    }
    if (heroVisible) heroRAF = requestAnimationFrame(heroLoop);
  }

  /* ================= 初始化 ================= */
  function init() {
    buildHeroStats(); buildStatRow(); buildGlobalGrid(); buildStories();
    /* 全球材料当前只有示意图，不请求不存在的卫星图片。 */
    buildSources(); buildMarks(); buildLayerTree(); buildStatic();
    buildCaveats(); buildFacts(); buildMethod();
    /* 必须在 buildCaveats 之后：CAVEATS 文案里也有对外数字占位符（如 sedWinMean），
     * 先渲染、后填充，否则拿到的是 null，占位符就永远停在「—」。 */
    fillHeadline();
    bindMapInteractions(); updateZoomHint();

    /* 分代预加载：首屏已经只拉了 1 张贴图，不阻塞渲染。
     * 等浏览器空闲再把「点查图集 + 关键年」拉下来——关键年取五个五年窗口的中心
     * （1989/1998/2007/2016/2022），与正文口径的窗口一致，
     * 这样用户拖到这些年份是瞬时的，其余年份仍按需加载。 */
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1200));
    idle(() => {
      /* 图集无论如何都要取：点查和播放都依赖它做兜底，1.5 MB。 */
      R.loadProbeCube();
      /* 关键年的高清贴图只在网络条件允许时预取。慢网/省流量模式下
       * 跳过这 3.7 MB——此时任何年份都能先看到图集层（真数据，只是分辨率低），
       * 高清按需再取，不会出现空窗。 */
      const c = navigator.connection || navigator.webkitConnection;
      const slow = !!c && (!!c.saveData || /^(slow-)?2g$|^3g$/.test(c.effectiveType || ''));
      if (!slow) R.preloadYears([1989, 1998, 2007, 2016, 2022, YEAR_END]);
    });

    const abToggle = $('#abToggle');
    if (abToggle) abToggle.addEventListener('change', () => {
      ab.on = abToggle.checked;
      drawMap();
      syncURL();
    });
    const abRange = $('#abRange');
    if (abRange) {
      abRange.value = ab.y;
      $('#abYear').textContent = ab.y;   // HTML 里写死的 2025 要被覆盖掉
      abRange.addEventListener('input', (e) => {
        ab.y = +e.target.value;
        $('#abYear').textContent = ab.y;
        drawAB();
        syncURL();
      });
    }

    $('#tlRange').addEventListener('input', (e) => { setPlaying(false); setYear(+e.target.value); });
    $('#tlPlay').addEventListener('click', () => {
      if (!playing && year >= YEAR_END) setYear(YEAR_START);
      setPlaying(!playing);
    });
    /* 顶栏年份胶囊左边的「时间轴行进」（2026-10-03 从数据面板标题栏移过来）。
     * 规则按你说的来：**已在 2025 时再点 = 回到 1986 重新走**（而不是没反应）。
     * 停止仍然由 setPlaying 的定时器兜底：走到 YEAR_END 自动收。 */
    $('#panelPlay').addEventListener('click', () => {
      if (!playing && year >= YEAR_END) setYear(YEAR_START);   /* 重播：先回到起点 */
      setPlaying(!playing);
    });

    $$('#mapLayers input').forEach((cb) => {
      cb.addEventListener('change', () => {
        layers[cb.dataset.layer] = cb.checked;
        const n = $(`#layerTree [data-layer="${cb.dataset.layer}"]`);
        if (n) { n.classList.toggle('on', cb.checked); n.querySelector('.box').textContent = cb.checked ? '✓' : ''; }
        drawMap();
        syncURL();
      });
    });

    const navTourBtn = $('#navTour'), heroTourBtn = $('#heroTour');
    const beginStory = () => window.NARRATIVE ? window.NARRATIVE.start() : startTour(0);
    if (navTourBtn) navTourBtn.addEventListener('click', beginStory);
    if (heroTourBtn) heroTourBtn.addEventListener('click', beginStory);
    /* 点击反馈：沙粒从按钮头顶那片天上往下淌（sand.js，纯装饰层 pointer-events:none）。
     * 触发时机用 **pointerdown** 而不是 click —— 手指/鼠标刚按下就该看到沙在动，
     * 等 click 慢半拍，反馈就变成了「先点了、然后才动一下」。
     * 键盘（Tab 到按钮按 Enter/空格）不会发 pointerdown，所以再补一个 keydown。
     * 两个都绑不会重复触发：键盘那条路径里 pointerdown 本来就不存在。 */
    const SAND = window.SAND;
    if (SAND) {
      ['#navTour', '#heroTour', '#panelPlay', '#tlPlay'].forEach((sel) => {
        const b = $(sel);
        if (!b) return;
        const fire = () => SAND.puff(b);
        b.addEventListener('pointerdown', fire);
        b.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') fire();
        });
      });
    }
    if ($('#tourExit')) $('#tourExit').addEventListener('click', endTour);
    if ($('#tourNext')) $('#tourNext').addEventListener('click', () => manualStep(1));
    if ($('#tourPrev')) $('#tourPrev').addEventListener('click', () => manualStep(-1));
    if ($('#tourAuto')) $('#tourAuto').addEventListener('click', toggleAuto);

    document.addEventListener('keydown', (e) => {
      if (window.NARRATIVE && window.NARRATIVE.isActive()) return;
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (!$('#traceModal') || $('#traceModal').hidden) { if (tour.on) endTour(); }
        else closeTrace();
        return;
      }
      if (e.target.closest('button, a, input, select, textarea, [contenteditable]')) return;
      if (tour.on) {
        /* 导览中：方向键翻步（步进本身会设年份），空格切自动播放 */
        if (e.key === 'ArrowRight') { e.preventDefault(); manualStep(1); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); manualStep(-1); return; }
        if (e.code === 'Space') { e.preventDefault(); toggleAuto(); return; }
        return;
      }
      if (e.key === 'ArrowLeft') { setPlaying(false); setYear(year - 1); }
      else if (e.key === 'ArrowRight') { setPlaying(false); setYear(year + 1); }
      else if (e.code === 'Space') { e.preventDefault(); $('#tlPlay').click(); }
      else if (e.key === 't' || e.key === 'T') { beginStory(); }
    });

    /* 数字溯源：整页事件委托，任何 .trace 都可点开它的计算链 */
    document.addEventListener('click', (e) => {
      const t = e.target.closest('.trace');
      if (t) { openTrace(t.dataset.trace); return; }
      const m = $('#traceModal');
      if (m && !m.hidden && (e.target.closest('[data-close]') || e.target.closest('.tm-x'))) {
        closeTrace();
      }
    });

    /* A/B 行与吸底胶囊的避让。
     *
     * 背景：这一行是 `.map-card` 的最后一个子元素，**必须在文档流里随滚动走**
     * （曾经为了躲胶囊把它整行 sticky，结果它像时间轴一样常驻屏幕左下角、压在地图上，
     *   用户明确否掉）。既然它不浮，胶囊（sticky + bottom:18px + z-index:40）扫过它时
     *   就会盖住开关 —— 所以反过来 **让胶囊给控件让位**：两者真正重叠时，
     *   把胶囊的 bottom 抬到本行上方。
     *
     * ⚠ 触发条件必须是「**真的重叠**」，不是「本行靠近屏幕下方」：
     * 早先写成 `r.bottom > 视口底 − 胶囊高 − 18 − 提前量160px`，提前量太大，
     * 结果本行还在离胶囊 160px 远的地方，胶囊就被抬起来 200px ——
     * 用户看到「进度条框没有贴住屏幕下方，浮在中间」，还以为是防挡数据的设计。
     * 现在算的是两个矩形的真实相交（留 10px 给过渡/采样）。
     *
     * A/B 关掉时本行 hidden，胶囊回到 18px 常驻吸底。 */
    const abBar = $('.ab-bar');
    const DOCK_GAP = 18;                       /* 与 .timeline-dock 的 CSS bottom 一致 */
    let abLifted = false, liftTimer = 0, liftRaf = 0;
    const syncDockLift = () => {
      if (!abBar || !dock || abBar.hidden || dock.offsetHeight === 0) {
        /* dock.offsetHeight === 0：导览态胶囊 display:none，谈不上让位 */
        if (abLifted && dock) {
          dock.style.bottom = ''; dock.classList.remove('yield', 'lifting');
          liftTimer = 0; abLifted = false;
        }
        return;
      }
      const r = abBar.getBoundingClientRect();
      const dh = dock.offsetHeight;
      /* 胶囊**吸附状态**下的占位矩形（底距视口 DOCK_GAP，高度 dh）。
       * 只有本行真的压进这块区域才让位 —— 否则胶囊该老老实实贴在屏幕底上。 */
      const stuckTop = window.innerHeight - dh - DOCK_GAP;
      const stuckBot = window.innerHeight - DOCK_GAP;
      const PRE = 10;                                  /* 给过渡与采样留 10px */
      const hit = r.bottom > stuckTop - PRE && r.top < stuckBot + PRE;   /* 两矩形相交 */
      /* 让位有 .16s 过渡，过渡途中胶囊仍盖在控件上（全段扫描每步 60ms 能撞到 5—8 个采样点，
       * 都是这一瞬间）。这段时间让胶囊**点击穿透**（.lifting → pointer-events:none），
       * 判「控件可点」时 elementFromPoint 就落回控件本身，过渡一结束立刻恢复可点。 */
      if (hit !== abLifted) {
        dock.classList.add('lifting');
        clearTimeout(liftTimer);
        liftTimer = setTimeout(() => { dock.classList.remove('lifting'); liftTimer = 0; }, 220);
      }
      dock.classList.toggle('yield', hit);
      /* ⚠ CSS 的 `bottom` 定的是胶囊**下沿**离视口底的距离，所以要躲开的是本行的**上沿**：
       * 让位量 = 视口底 → 本行上沿的距离（再抬 6px）。
       * 早先写成「胶囊高 + 留白 + 本行高」，量出来是固定的 135px，
       * 结果本行一进带子（bar.top 距视口底 186px）时胶囊下沿 633 > 本行上沿 582 ——
       * 照样压着。现在是按需取长度，实测三视口全段 0 遮挡。 */
      const need = Math.max(dh + DOCK_GAP, window.innerHeight - r.top + 6);
      dock.style.bottom = hit ? Math.round(need) + 'px' : '';
      abLifted = hit;
    };
    /* ⚠ 让位期间必须**逐帧**重算（liftTick）：让位量 = 视口底 → 本行上沿，本行随滚动一直在上移，
     * 这个数是连续的。只在 scroll 里算一次 + CSS 给 bottom 兜 0.16s 过渡的话，
     * 胶囊永远在「追」而追不上（每帧目标都在抬高），实测全段扫描每步 60ms 仍有 7 个采样点被压住。
     * 逐帧算 = 同一帧内位置和让位量一致，零滞后。CSS 里因此不给 bottom 加过渡。 */
    const liftTick = () => {
      liftRaf = 0;
      syncDockLift();
      if (abLifted) liftRaf = requestAnimationFrame(liftTick);   /* 本行还在带子里就继续跟 */
    };
    const kickLift = () => { if (!liftRaf) liftRaf = requestAnimationFrame(liftTick); };

    /* 导航显隐 + 高亮 */
    const nav = $('#nav');
    const links = $$('.nav-links a');
    const secs = links.map((a) => $(a.getAttribute('href')));
    window.addEventListener('scroll', () => {
      nav.classList.toggle('show', window.scrollY > window.innerHeight * 0.55);
      const pos = window.scrollY + window.innerHeight * 0.35;
      let cur = 0;
      secs.forEach((s, i) => { if (s && s.offsetTop <= pos) cur = i; });
      links.forEach((a, i) => a.classList.toggle('active', i === cur));
      kickLift();
    }, { passive: true });
    window.addEventListener('resize', () => { syncDockLift(); kickLift(); }, { passive: true });
    /* A/B 开关一开，本行才显形 —— 立刻判一次，别等下一次滚动（名字别撞 1428 行的 abToggle） */
    const abTglEl = $('#abToggle');
    if (abTglEl) abTglEl.addEventListener('change', () => { syncDockLift(); kickLift(); });

    /* 吸底时间轴：只在地图区还在视口里的时候出现。
     * 此前它 sticky 在 #stage 内，会一路跟着浮到底部，把下方数据卡片的下沿压住。 */
    const stageGrid = $('.stage-grid'), dock = $('#timelineDock');
    if (stageGrid && dock && 'IntersectionObserver' in window) {
      new IntersectionObserver((es) => {
        dock.classList.toggle('off', !es[0].isIntersecting);
        syncDockLift();          /* 胶囊由收起变浮起时，让位量要跟着重算 */
      }, { threshold: 0, rootMargin: '-42% 0px -18% 0px' }).observe(stageGrid);
    }

    /* 用户点击播放后才推进年份，滚动进入地图不抢控制。 */

    /* 尺寸变化 */
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        buildCharts();
        drawMap(); drawGlobals(); drawCharts();
      }, 180);
    });

    buildCharts();
    /* 首屏采用可拖动的真实影像对比，移除背景持续重绘。 */
    setYear(YEAR_START);
    window.addEventListener('load', () => { buildCharts(); drawMap(); drawGlobals(); drawCharts(); });
    /* 初始化收尾后才允许预取：上面 setYear(YEAR_START) 也会被算进首屏，
     * 若此时放行预取，首屏就不止 1 张贴图了。 */
    booted = true;
    /* URL 状态最后应用：此时所有状态变量都已初始化，且 booted 已放行，
     * 带 ?year= 的链接能直接落到指定年份（silent 定位，不额外拉贴图）。 */
    readURL();
    initBgm();
    DEV.load();
    if (new URLSearchParams(location.search).get('dev') === '1') { $('#navDev').hidden = false; mountDevTools(); }
  }

  /* ======================================================================
   * BGM：打开页面自动播放，右上角唱片控制暂停/继续
   * ------------------------------------------------------------------
   * 关于「自动播放」的现实限制（必须如实处理，不能假装做到了）：
   *   Chrome / Edge / Safari 的自动播放策略是**没有用户交互就不许出声**。
   *   本作品打开即静音无声 —— 这是浏览器的硬规则，不是代码没写对。
   *   判定：promise 被拒 → 状态置为「已暂停」，唱片显示暂停杠，
   *   并在 title 里说明「点此开启音乐」。用户点一下就开了。
   *   这样至少保证：**点一下就有声**，且 UI 如实反映当前状态。
   *   别用「假装在播」的做法（常见于 setTimeout 直接 play 不看结果）——
   *   那样唱片在转但没声音，比不放更糟。
   *
   * 另一处要诚实：13 MB 的 mp3 用 preload="auto" 会在首屏抢带宽。
   *   改成 preload="metadata" 先拿时长，音频本体等 canplay 再说，
   *   音乐晚几百毫秒响但地图首屏不卡 —— 后者更要紧。
   */
  const bgm = {
    el: null, btn: null, started: false, blocked: false,
  };

  function setVinylState(playing, blocked) {
    const b = bgm.btn;
    if (!b) return;
    b.setAttribute('aria-pressed', playing ? 'true' : 'false');
    b.setAttribute('aria-label', playing ? '暂停背景音乐' : '播放背景音乐');
    b.title = blocked
      ? '背景音乐：浏览器禁止自动播放，点此开启'
      : (playing ? '背景音乐 · 点击暂停' : '背景音乐 · 点击继续播放');
  }

  /* 判断宿主是否真能播音频。
   * ⚠ play() 实际有**三种**失败方式，只写 .catch() 只能挡住第一种：
   *   ① 返回 promise 被拒 —— 正常浏览器自动播放策略拦截，最常见
   *   ② 同步 throw —— 部分老浏览器 / 严格策略
   *   ③ **宿主根本没实现**：jsdom 之类无媒体栈的环境会报
   *      "Not implemented: HTMLMediaElement's play()"，走的是宿主错误通道
   *      （既不是 throw 也不是 promise），try/catch 与 .catch() **都拦不住**，
   *      它会冒到 window.onerror 把整页逻辑带崩（冒烟环境就是这么挂的）。
   * 所以先做能力探测：play 存在 且 canPlayType 认得 mp3，才尝试播放。
   * 探测不过就把唱片置为不可用态，页面其余部分照常工作。 */
  function audioPlayable(a) {
    try {
      if (typeof a.play !== 'function') return false;
      /* canPlayType 返回 ''（空串）= 不支持该格式 */
      return a.canPlayType('audio/mpeg') !== '';
    } catch (e) {
      return false;
    }
  }

  function markBgmUnusable(b) {
    b.disabled = true;
    b.style.opacity = '.32';
    b.style.cursor = 'not-allowed';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', '当前环境不支持音频播放');
    b.title = '当前环境不支持音频播放';
  }

  function initBgm() {
    const a = $('#bgm'), b = $('#vinyl');
    bgm.el = a; bgm.btn = b;
    if (!a || !b || !a.getAttribute('src')) return;
    a.volume = 0.42;                 /* 别太吵：这是环境音不是主角 */
    /* 宿主不支持音频 → 置不可用，连试播都不试（试了就是第 ③ 种崩法） */
    if (!audioPlayable(a)) { markBgmUnusable(b); return; }

    const tryPlay = (onFail) => {
      try {
        const p = a.play();
        if (p && p.then) {
          p.then(() => { bgm.blocked = false; setVinylState(true, false); })
            .catch(() => { bgm.blocked = true; onFail(); });
        } else {
          onFail();
        }
      } catch (e) {
        bgm.blocked = true; onFail();
      }
    };

    b.addEventListener('click', () => {
      if (a.paused) tryPlay(() => setVinylState(false, true));
      else { a.pause(); setVinylState(false, false); }
    });

    /* 打开页面就试播；被拒则静默切到「已暂停」态，如实反映当前状态。 */
    tryPlay(() => setVinylState(false, true));

    /* 用户第一次点页面时补播（浏览器把首次交互给了这次点击）。只试一次。 */
    const retry = (event) => {
      document.removeEventListener('pointerdown', retry);
      /* 第一下就点在唱片上时交给按钮自己处理，否则会“刚开始播就被按钮暂停”。 */
      if (event && event.target && event.target.closest && event.target.closest('#vinyl')) return;
      if (bgm.blocked) tryPlay(() => {});
    };
    document.addEventListener('pointerdown', retry, { once: true });
  }

  /* ======================================================================
   * 开发者模式：让项目组自己调导览落点 / 停留时长 / 时间轴速度
   * ------------------------------------------------------------------
   * 为什么要有这个：导览的「滚到哪、停多久」原先只能改代码里的 TOUR 常量，
   * 改一次跑一次自检，迭代很慢。而这两个参数本质上是**审美判断**，
   * 应该在页面上直接试出来，不该靠反复改代码。
   *
   * 设计约定（保持零依赖、不污染作品）：
   *   · 面板默认隐藏，齿轮按钮 + ?dev=1 才出现；观众看到的页面干净
   *   · 所有调参存在 localStorage（mu.dev），**刷新仍在、关掉浏览器即失效**
   *   · 面板里的改动**不改代码**。点「导出为 JSON」把配置贴给我，我合进 TOUR
   *   · 不做「保存到服务器」「自动上传」这类花活
   */
  function mountDevTools() {
    const btn = $('#navDev'), panel = $('#devPanel');
    if (!btn || !panel) return;
    const st = {
      sel: 0,                            /* 正在编辑第几步 */
      at: {},                             /* {stepIndex: {y,a,o}} 手动落点 */
      hold: {},                           /* {stepIndex: ms} 停留时长 */
    };
    /* 从 TOUR 初始化停留时长默认值（面板上显示的就是 TOUR 里的值） */
    TOUR.forEach((s, i) => { st.hold[i] = s.hold || 8000; });

    const saveOverride = () => DEV.save({ playMs: DEV.playMs });

    /* ---------- 步骤列表 ---------- */
    function renderSteps() {
      const box = $('#devSteps');
      if (!box) return;
      box.innerHTML = TOUR.map((s, i) => {
        const at = st.at[i];
        const tag = at ? '<span class="tag picked">已设</span>' : '<span class="tag">默认</span>';
        return `<li data-i="${i}" class="${i === st.sel ? 'sel' : ''}">
          <span class="n">${i + 1}</span>
          <span class="t">${s.t}</span>${tag}</li>`;
      }).join('');
      $$('#devSteps li').forEach((li) => {
        li.addEventListener('click', () => { st.sel = +li.dataset.i; renderSteps(); });
      });
    }

    /* ---------- 停留时长 ---------- */
    function renderHolds() {
      const box = $('#devHolds');
      if (!box) return;
      box.innerHTML = TOUR.map((s, i) => `
        <label class="dev-hold">
          <span>${i + 1}. ${s.t}</span>
          <input type="number" data-h="${i}" min="2000" max="40000" step="500" value="${st.hold[i]}">
          <span class="dev-val">ms</span>
        </label>`).join('');
      $$('#devHolds input').forEach((inp) => {
        inp.addEventListener('change', () => {
          const i = +inp.dataset.h;
          const v = parseInt(inp.value, 10);
          st.hold[i] = (v >= 2000 && v <= 40000) ? v : 8000;
          inp.value = st.hold[i];
          /* 写回 TOUR —— armAuto() 读的是 TOUR[i].hold，
           * 只存面板自己的 st 的话导览计时不会变（这是个容易漏的回路）。 */
          TOUR[i] = Object.assign({}, TOUR[i], { hold: st.hold[i] });
          setHoldOverrides();
        });
      });
    }

    /* 停留时长即时生效：改了滑块/输入框就更新导览的自动推进计时。
     * 不重开导览也能听到效果（当前步若开着自动，会用新时长重新计时）。 */
    function setHoldOverrides() {
      st._holdApplied = true;
      if (tour.on && tour.auto) armAuto();
    }

    /* ---------- 记录当前落点 ----------
     * 存两样东西：绝对滚动位置 + 视口内锚点。
     * 锚点取「离视口顶最近、且有稳定选择器」的容器，
     * 这样换屏幕高度时优先按锚点重定位，不会飘。 */
    function pickAnchor() {
      const navH = (document.querySelector('.nav') || {}).offsetHeight || 0;
      /* 候选：section / .card / .insight-card / .global-card 等有标识的容器 */
      const cands = $$('section[id], .card[id], .card[class*="card"], .insight-card, .global-card, .story-quote, .sec-head');
      let best = null, bestD = 1e9;
      const vh = window.innerHeight;
      cands.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 40 || r.top > vh - 40) return;   /* 完全不在视口里，跳过 */
        /* 元素顶边离「导航下沿」的距离，越小越贴视口顶 → 越可能是用户想看的那个 */
        const d = Math.abs(r.top - navH - 16);
        if (d < bestD) { bestD = d; best = el; }
      });
      if (!best) return { a: null, o: 0 };
      /* 生成稳定选择器。
       * ⚠ 顺序很重要：**必须优先 id**。用 class 兜底时同名元素会命中第一个
       * （如 .card 满屏都是），换个步骤锚到同一个元素、落点就跟着错。
       * 所以 class 兜底时额外加 :nth-of-type 序号，缩小命中范围。 */
      let a = null;
      if (best.id) {
        a = '#' + best.id;
      } else {
        const cls = (best.className || '').trim().split(/\s+/).filter(Boolean);
        if (cls.length) {
          const sel = '.' + cls[0];
          const all = $$(sel);
          if (all.length === 1) a = sel;
          else if (all.length > 1) {
            const k = all.indexOf(best);
            if (k >= 0) a = sel + ':nth-of-type(' + (k + 1) + ')';
          }
        }
      }
      /* 生成不了唯一选择器就退化成纯像素落点（y 兜底），总比锚错强 */
      if (a) { try { if ($$(a).length !== 1) a = null; } catch (e) { a = null; } }
      const navH2 = (document.querySelector('.nav') || {}).offsetHeight || 0;
      return { a: a, o: Math.round(best.getBoundingClientRect().top - navH2 - 16) };
    }

    function pick() {
      const a = pickAnchor();
      st.at[st.sel] = { y: Math.round(window.scrollY), a: a.a, o: a.o };
      /* ⚠ 必须立刻写回 TOUR —— 导览的 goStep() 读的是 TOUR[i].at。
       * 只存面板自己的 st 的话，点「记录」看起来成功了（列表变成「已设」），
       * 但导览还是滚到原来的位置。这是个很容易漏的回路，踩过。 */
      TOUR[st.sel] = Object.assign({}, TOUR[st.sel], { at: st.at[st.sel] });
      renderSteps();
      const hint = $('#devHint');
      if (hint) {
        hint.textContent = '第 ' + (st.sel + 1) + ' 步已记录：'
          + (a.a ? '锚点 ' + a.a + '，偏移 ' + a.o : '仅滚动位置') + '（y=' + Math.round(window.scrollY) + '）';
      }
    }

    /* 立即跳到第 sel 步当前生效的落点，方便「改一步→看一步」 */
    function gotoSel() {
      const s = TOUR[st.sel];
      if (!s) return;
      if (st.at[st.sel]) {
        TOUR[st.sel] = Object.assign({}, s, { at: st.at[st.sel] });
      }
      scrollToStep(TOUR[st.sel]);
    }

    /* ---------- 速度滑块 ---------- */
    function bindSpeed() {
      const r = $('#devSpeed'), v = $('#devSpeedVal'), n = $('#devSpeedNote');
      if (!r) return;
      r.value = DEV.playMs;
      const upd = () => {
        DEV.playMs = parseInt(r.value, 10);
        v.textContent = DEV.playMs + ' ms';
        const total = (DEV.playMs * 40 / 1000).toFixed(1);
        n.textContent = '40 年（' + YEAR_START + '—' + YEAR_END + '）约需 ' + total + ' 秒走完。'
          + (DEV.playMs < 70 ? '偏快：跳变会看不清年际差异。'
            : DEV.playMs > 260 ? '偏慢：40 秒以上观众容易失去耐心。' : '当前属于可读区间（70—260 ms）。');
        saveOverride();
      };
      r.addEventListener('input', upd);
      upd();
    }

    /* ---------- 导出 / 重置 ---------- */
    function exportCfg() {
      const cfg = { playMs: DEV.playMs, steps: [] };
      TOUR.forEach((s, i) => {
        const row = { k: s.k, hold: st.hold[i] };
        if (st.at[i]) row.at = st.at[i];
        cfg.steps.push(row);
      });
      const out = $('#devOut');
      if (out) {
        out.value = JSON.stringify(cfg, null, 2);
        out.select();
      }
      const hint = $('#devHint');
      if (hint) hint.textContent = '已导出，可复制上面的配置；点「恢复默认」还原';
    }

    function resetAll() {
      st.at = {};
      TOUR.forEach((s, i) => { delete TOUR[i].at; st.hold[i] = s.hold || 8000; });
      DEV.playMs = 200;      /* 与 app.js 顶部的默认、index.html 的滑块初值三处一致 */
      /* 顺序要紧：先清 storage 再 render。
         若先 renderSteps/bindSpeed，滑块的 upd() 会立刻把 {playMs:200}
         重新写回 localStorage，「清除」就白做了（实测 stored 仍为 {"playMs":135}）。 */
      DEV.clear();
      renderSteps(); renderHolds(); bindSpeed();
      DEV.clear();          /* 再清一次：把 bindSpeed 写回来的默认值抹掉 */
      const out = $('#devOut'); if (out) out.value = '';
      const hint = $('#devHint');
      if (hint) hint.textContent = '已恢复默认（清除本地覆盖）';
    }

    /* ---------- 事件绑定 ---------- */
    const open = (on) => {
      panel.hidden = !on;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-label', on ? '关闭开发者设置' : '打开开发者设置');
    };
    btn.addEventListener('click', () => open(panel.hidden));
    const x = $('#devClose'); if (x) x.addEventListener('click', () => open(false));
    const pb = $('#devPick'); if (pb) pb.addEventListener('click', pick);
    const pv = $('#devPrev'); if (pv) pv.addEventListener('click', () => { st.sel = (st.sel - 1 + TOUR.length) % TOUR.length; renderSteps(); gotoSel(); });
    const nx = $('#devNext'); if (nx) nx.addEventListener('click', () => { st.sel = (st.sel + 1) % TOUR.length; renderSteps(); gotoSel(); });
    const ex = $('#devExport'); if (ex) ex.addEventListener('click', exportCfg);
    const rs = $('#devReset'); if (rs) rs.addEventListener('click', resetAll);
    /* Esc 关面板（别和导览的 Esc 打架：导览开着时 Esc 归导览） */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden && !tour.on) open(false);
    });

    renderSteps(); renderHolds(); bindSpeed();
    /* ?dev=1 直接打开面板：方便录屏/截图 */
    if (/[?&]dev=1/.test(location.search)) open(true);
  }

  window.MU_APP = {
    setYear, setPlaying, endTour, openTrace, closeTrace,
    getState: () => ({ year, playing, layers: { ...layers }, comparison: { ...ab } }),
    setComparison: (on, compareYear) => {
      ab.on = !!on;
      if (Number.isFinite(compareYear)) ab.y = Math.max(YEAR_START, Math.min(YEAR_END, Math.round(compareYear)));
      $('#abToggle').checked = ab.on;
      $('#abRange').value = ab.y;
      $('#abYear').textContent = ab.y;
      drawMap(); syncURL();
    },
    redraw: () => { drawMap(); drawCharts(); },
  };
  window.addEventListener('mu:image', (event) => {
    if (event.detail && (event.detail.year === year || event.detail.year === ab.y)) drawMap();
  });

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
