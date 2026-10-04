/* 遥感图层：完整年度图优先；播放时可用同源预览。
 * 加载失败显示状态，不用程序生成的图形替代毛乌素遥感观测。
 * 分析尺度、导出图像尺寸和浏览器显示像素是三件不同的事。
 */
(function () {
  const { mulberry32, GEO } = window.DATA;

  /* ---------------- 噪声 ---------------- */
  function makeNoise2D(seed) {
    const rnd = mulberry32(seed);
    const S = 64, tab = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) tab[i] = rnd();
    const g = (i, j) => tab[(((j % S) + S) % S) * S + (((i % S) + S) % S)];
    return function (x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1);
      const tx = fx * fx * (3 - 2 * fx), ty = fy * fy * (3 - 2 * fy);
      const t0 = a + (b - a) * tx, t1 = c + (d - c) * tx;
      return t0 + (t1 - t0) * ty;
    };
  }
  function fbm(n, x, y, oct) {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { v += n(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return v / norm;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------------- NDVI 色带 ---------------- */
  const NDVI_RAMP = [
    [0.00, [138, 108, 72]], [0.06, [172, 140, 91]], [0.12, [201, 174, 113]],
    [0.20, [217, 197, 127]], [0.28, [178, 193, 117]], [0.38, [124, 168, 91]],
    [0.50, [74, 139, 73]], [0.65, [40, 105, 58]], [0.80, [21, 73, 45]],
    [1.00, [12, 52, 34]],
  ];
  function ndviColor(v) {
    v = clamp(v, 0, 1);
    for (let i = 0; i < NDVI_RAMP.length - 1; i++) {
      const [p0, c0] = NDVI_RAMP[i], [p1, c1] = NDVI_RAMP[i + 1];
      if (v <= p1) {
        const t = (v - p0) / (p1 - p0 || 1);
        return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
      }
    }
    return NDVI_RAMP[NDVI_RAMP.length - 1][1];
  }

  /* ---------------- 色带反查：RGB → NDVI ----------------
   * 用途：把「当年真实影像（或图集层）的着色结果」还原成 NDVI，
   * 这样叠加层与底图**来自同一张图**，读者可以拿图例自己复算。
   * 做法：在色带折线上找最近点（分段线性投影），比「取最近色标」精度高一个量级；
   * 若最近点距离超过阈值（水体、云、无效色），返回 null —— 判为色带外，不参与描边。 */
  const RAMP_MAX_DIST2 = 900;      /* ≈ 每轴 30 灰阶，远大于色带自身段间距离 */
  // 原年度 PNG 的 255 级索引色表经逐文件核对：7 色等距，范围 0—0.7。
  const ANNUAL_RAMP = [[138,108,72], [201,174,113], [217,197,127],
    [178,193,117], [124,168,91], [74,139,73], [40,105,58]]
    .map((color, index) => [index * 0.7 / 6, color]);
  function colorToRampNDVI(r, g, b, ramp) {
    let best = 1e9, bv = 0;
    for (let i = 0; i < ramp.length - 1; i++) {
      const c0 = ramp[i][1], c1 = ramp[i + 1][1];
      const dx = c1[0] - c0[0], dy = c1[1] - c0[1], dz = c1[2] - c0[2];
      const L2 = dx * dx + dy * dy + dz * dz || 1;
      const t = clamp(((r - c0[0]) * dx + (g - c0[1]) * dy + (b - c0[2]) * dz) / L2, 0, 1);
      const px = c0[0] + dx * t, py = c0[1] + dy * t, pz = c0[2] + dz * t;
      const d = (r - px) * (r - px) + (g - py) * (g - py) + (b - pz) * (b - pz);
      if (d < best) { best = d; bv = lerp(ramp[i][0], ramp[i + 1][0], t); }
    }
    return best > RAMP_MAX_DIST2 ? null : bv;
  }
  function colorToNDVI(r, g, b) { return colorToRampNDVI(r, g, b, NDVI_RAMP); }
  function annualColorToNDVI(r, g, b) { return colorToRampNDVI(r, g, b, ANNUAL_RAMP); }

  /* NDVI < 0.12 的低 NDVI 像元，不是流动沙地分类结果。
   * 掩膜与本次显示的源图保持一致；预览切到完整图后重新计算。
   */
  const BARE_NDVI = 0.12;
  const bareCache = new Map();
  function bareMask(year, source) {
    const image = source || realImgs[year] || cubeLayer(year);
    if (!image) return null;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const key = `${year}:${width}x${height}`;
    if (bareCache.has(key)) return bareCache.get(key);
    const grid = mkGrid(width, height);
    const context = grid.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    let pixels;
    try { pixels = context.getImageData(0, 0, width, height).data; }
    catch (error) { warnOnce('low-NDVI pixel access failed: ' + error.name); return null; }
    const mask = new Uint8Array(width * height);
    const inverse = new Map();
    for (let i = 0; i < mask.length; i++) {
      const offset = i * 4;
      if (pixels[offset + 3] < 8) { mask[i] = 255; continue; }
      const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
      let value = inverse.get(key);
      if (value === undefined) {
        value = annualColorToNDVI(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
        inverse.set(key, value);
      }
      mask[i] = value == null ? 255 : value < BARE_NDVI ? 1 : 0;
    }
    const result = { data: mask, width, height };
    if (bareCache.size >= 6) bareCache.delete(bareCache.keys().next().value);
    bareCache.set(key, result);
    return result;
  }
  let warned = false;
  function warnOnce(tag) {
    if (warned) return;
    warned = true;
    if (window.console && console.warn) console.warn('[render] 叠加层数据未就绪（' + tag + '）：宁可不画，也不画错的');
  }

  /* ---------------- 工具：网格画布 ---------------- */
  function mkGrid(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* ======================================================================
   * 一、毛乌素沙地 NDVI 场
   * ==================================================================== */
  const MU_W = 264, MU_H = 184;
  const lowNDVICanvases = new Map();
  const bbox = GEO.bbox;
  const lon2gx = (lon) => ((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * MU_W;
  const lat2gy = (lat) => ((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * MU_H;

  const realImgs = {};
  const imageRecords = new Map();
  const imageQueue = [];
  const PRE_MAX = 3;
  let preActive = 0;

  function emitImageState(year, state) {
    if (typeof window.CustomEvent === 'function' && window.dispatchEvent) {
      window.dispatchEvent(new window.CustomEvent('mu:image', { detail: { year, state } }));
    }
    if (window.__onRealLoaded) window.__onRealLoaded();
  }

  function pumpPre() {
    while (preActive < PRE_MAX && imageQueue.length) {
      const year = imageQueue.shift();
      const record = imageRecords.get(year);
      if (!record || record.state !== 'queued') continue;
      preActive++;
      record.state = 'loading';
      const image = new Image();
      record.image = image;
      let settled = false;
      const finish = (state) => {
        if (settled) return;
        settled = true;
        clearTimeout(record.timer);
        record.state = state;
        realImgs[year] = state === 'ready' ? image : null;
        preActive--;
        emitImageState(year, state);
        pumpPre();
      };
      image.onload = () => finish(image.naturalWidth && image.naturalHeight ? 'ready' : 'error');
      image.onerror = () => finish('error');
      record.timer = setTimeout(() => finish('error'), 30000);
      image.src = `assets/img/ndvi/${year}.png`;
    }
  }

  function tryRealImage(year) {
    if (!Number.isInteger(year) || year < window.DATA.YEAR_START || year > window.DATA.YEAR_END) return null;
    if (!imageRecords.has(year)) {
      imageRecords.set(year, { state: 'queued', image: null, timer: null });
      realImgs[year] = null;
      imageQueue.unshift(year);
      pumpPre();
    }
    if (imageState(year) === 'queued') {
      const index = imageQueue.indexOf(year);
      if (index >= 0) { imageQueue.splice(index, 1); imageQueue.unshift(year); }
      pumpPre();
    }
    return realImgs[year] || null;
  }

  function imageState(year) { return imageRecords.get(year)?.state || 'idle'; }
  function retryRealImage(year) {
    if (imageState(year) === 'error') { imageRecords.delete(year); delete realImgs[year]; }
    return tryRealImage(year);
  }
  function preloadYears(years) {
    years.forEach((year) => {
      if (!Number.isInteger(year) || year < window.DATA.YEAR_START || year > window.DATA.YEAR_END || imageRecords.has(year)) return;
      imageRecords.set(year, { state: 'queued', image: null, timer: null });
      imageQueue.push(year);
      realImgs[year] = null;
    });
    pumpPre();
  }

  const CUBE_URL = 'assets/img/probe_cube.png';
  const CUBE_COLS = 8;                 /* 图集排布：8 列 x 5 行 = 40 年 */
  let cubeData = null;                 /* Uint8ClampedArray | null */
  let cubeState = 'idle';              /* idle | loading | ready | error */
  const cubeCbs = [];

  function loadProbeCube() {
    if (cubeState !== 'idle') return cubeState;
    cubeState = 'loading';
    const image = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cubeState = ok ? 'ready' : 'error';
      cubeCbs.splice(0).forEach((fn) => fn(ok));
      emitImageState(null, cubeState);
    };
    const timer = setTimeout(() => finish(false), 30000);
    image.onload = () => {
      if (image.naturalWidth !== CUBE_COLS * MU_W || image.naturalHeight !== 5 * MU_H) {
        finish(false); return;
      }
      try {
        const grid = mkGrid(image.naturalWidth, image.naturalHeight);
        const context = grid.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        cubeData = context.getImageData(0, 0, grid.width, grid.height).data;
        finish(true);
      } catch (error) {
        warnOnce('preview access failed: ' + error.name);
        finish(false);
      }
    };
    image.onerror = () => finish(false);
    image.src = CUBE_URL;
    return cubeState;
  }
  function retryProbeCube() {
    if (cubeState === 'error') cubeState = 'idle';
    return loadProbeCube();
  }
  function probeCube() { return cubeState === 'ready' ? cubeData : null; }
  function probeCubeState() { return cubeState; }

  /* 同源图集用于快速浏览；264×184 是预览尺寸，不是 500 米分析网格。 */
  const cubeLayers = {};
  function cubeLayer(year) {
    if (cubeState !== 'ready' || !cubeData) return null;
    if (cubeLayers[year]) return cubeLayers[year];
    const k = year - window.DATA.YEAR_START;
    if (!(k >= 0 && k < CUBE_COLS * 5)) return null;
    const r = Math.floor(k / CUBE_COLS), c = k % CUBE_COLS;
    const aw = CUBE_COLS * MU_W;
    const g = mkGrid(MU_W, MU_H);
    const c2 = g.getContext('2d');
    const img = c2.createImageData(MU_W, MU_H);
    for (let y = 0; y < MU_H; y++) {
      const src = ((r * MU_H + y) * aw + c * MU_W) * 4;
      img.data.set(cubeData.subarray(src, src + MU_W * 4), y * MU_W * 4);
    }
    c2.putImageData(img, 0, 0);
    cubeLayers[year] = g;
    return g;
  }

  /* 当前实际图层：完整图、降采样预览、加载中、错误。 */
  let lastKind = 'loading';
  let lastStretchVal = null;
  function lastLayerKind() { return lastKind; }
  function lastStretch() { return lastStretchVal; }
  function onProbeCubeReady(fn) {
    if (cubeState === 'ready' || cubeState === 'error') { fn(cubeState === 'ready'); return; }
    cubeCbs.push(fn);
    loadProbeCube();
  }

  /** 渲染毛乌素主图。
   *  view = { s, x, y } | undefined  为交互层 C1 的缩放平移：
   *  底图与全部叠加层（沙地边界/经纬网/黄河/地名）统一活在变换后的
   *  逻辑坐标系里，因此缩放只需在绘制外侧加一次 translate+scale。 */
  function drawMapPlaceholder(ctx, canvas, year, failed) {
    const width = canvas.width, height = canvas.height;
    const dpr = canvas.clientWidth ? width / canvas.clientWidth : 1;
    ctx.fillStyle = '#17231f';
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.max(14, Math.min(20, width / dpr / 28)) * dpr}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = '#e2ece3';
    ctx.fillText(failed ? `${year} 年影像未能加载` : `正在加载 ${year} 年影像`, width / 2, height / 2 - 14 * dpr);
    ctx.font = `${12 * dpr}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = '#a9beb0';
    ctx.fillText(failed ? '请检查网络，或用本地 HTTP 服务打开项目。' : '图像尚未就绪，请稍候。', width / 2, height / 2 + 16 * dpr);
    ctx.textAlign = 'start';
  }

  function drawLowNDVI(ctx, source, year, width, height) {
    const mask = bareMask(year, source);
    if (!mask) return;
    const key = `${year}:${mask.width}x${mask.height}`;
    if (lowNDVICanvases.has(key)) {
      ctx.drawImage(lowNDVICanvases.get(key), 0, 0, width, height);
      return;
    }
    const overlay = mkGrid(mask.width, mask.height);
    const context = overlay.getContext('2d');
    const image = context.createImageData(mask.width, mask.height);
    const data = mask.data;
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        const index = y * mask.width + x;
        if (data[index] !== 1) continue;
        const edge = x === 0 || x === mask.width - 1 || y === 0 || y === mask.height - 1
          || data[index - 1] !== 1 || data[index + 1] !== 1
          || data[index - mask.width] !== 1 || data[index + mask.width] !== 1;
        image.data.set([239, 164, 73, edge ? 185 : 48], index * 4);
      }
    }
    context.putImageData(image, 0, 0);
    if (lowNDVICanvases.size >= 6) lowNDVICanvases.delete(lowNDVICanvases.keys().next().value);
    lowNDVICanvases.set(key, overlay);
    ctx.drawImage(overlay, 0, 0, width, height);
  }

  function renderMuUs(canvas, year, layers, view, opts) {
    const ctx = canvas.getContext('2d');
    const cw = canvas.width, ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const vs = view ? view.s : 1, vx = view ? view.x : 0, vy = view ? view.y : 0;
    // 播放时复用已缓存的完整图；暂停或放大时主动请求完整图。
    const atlasOnly = !!(opts && opts.atlasOnly) && vs <= 1.2;
    const real = realImgs[year] || (!atlasOnly ? tryRealImage(year) : null);
    if (!real && cubeState === 'idle') loadProbeCube();
    const atlas = real ? null : cubeLayer(year);
    const source = real || atlas;
    if (!source) {
      const failed = cubeState === 'error' && (atlasOnly || imageState(year) === 'error');
      lastKind = failed ? 'error' : 'loading';
      lastStretchVal = null;
      drawMapPlaceholder(ctx, canvas, year, failed);
      return;
    }
    ctx.save();
    if (vs !== 1 || vx !== 0 || vy !== 0) { ctx.translate(vx, vy); ctx.scale(vs, vs); }
    const sourceWidth = source.naturalWidth || source.width;
    const stretch = cw * vs / sourceWidth;
    lastStretchVal = stretch;
    // 超过导出像素后显示实际像素，不能用平滑制造新的空间信息。
    ctx.imageSmoothingEnabled = stretch <= 1.5;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, cw, ch);
    lastKind = real ? 'real' : 'atlas';
    if (layers.boundary) drawLowNDVI(ctx, source, year, cw, ch);
    ctx.imageSmoothingEnabled = true;

    /* --- 3. 经纬网 --- */
    if (layers.grid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.13)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (let lon = 107.5; lon <= 110.5; lon += 0.5) {
        const x = lon2gx(lon) / MU_W * cw;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
      }
      for (let lat = 37.5; lat <= 39.5; lat += 0.5) {
        const y = lat2gy(lat) / MU_H * ch;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
      }
      ctx.restore();
    }

    /* --- 4. 黄河 --- */
    if (layers.river) {
      ctx.save();
      ctx.strokeStyle = 'rgba(88,168,222,.92)';
      ctx.lineWidth = Math.max(2.2, cw / 300);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(60,150,210,.55)'; ctx.shadowBlur = 8;
      ctx.beginPath();
      GEO.yellowRiver.forEach(([lo, la], k) => {
        const x = lon2gx(lo) / MU_W * cw, y = lat2gy(la) / MU_H * ch;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();   /* 配对 view 变换的 save */

    /* --- 6. 注记层：地名 + 行政区划（矢量数据，来自 geo.js / data.js）
     * ------------------------------------------------------------------
     * 刻意画在 view 变换**之外**，原因有二，缺一不可：
     *
     * ① 放大不糊：行政区界**本来就是矢量**，不该被 500 m 栅格贴图拖累
     *    （贴图每像素 261 m，1.5× 起就进入可见插值区）。
     *    矢量要素不参与插值 → 任意倍数都锐利。
     *
     * ② 字和线不能跟着缩放放大（这是此前一直存在的洞）：
     *    在变换内 `ctx.font = 13px` 会被 ctx.scale(vs) 一起放大，
     *    4.4× 下「靖边」两个字占掉四分之一屏。原实现一直如此，
     *    只是以前没人放大到能看见的程度（1× 时 vs=1，看不出问题）。
     *    移出变换后：线宽字号按**屏幕像素**给，坐标自己乘 vs。
     */
    /* dpr 由画布实测：backing / CSS 宽。clientWidth 为 0（卡片尚未布局）时退回 1，
     * 等卡片显示后渲染循环会重画，不会一直糊着。 */
    const dpr = canvas.clientWidth ? cw / canvas.clientWidth : 1;
    drawLabels(ctx, cw, ch, view, layers, dpr);
  }

  /* 道路网绘制样式。
   * 配色对齐常见地图习惯：高速橙红、国道橙、省道黄白——
   * 与行政界的亮金/淡白要在**明度**上拉开，否则叠在一起分不出谁是谁
   * （实测：省界 2.4px 亮金 vs 高速 2.2px 橙，不拉开就是两条同色粗线）。 */
  const ROAD_STYLE = {
    expressway: { w: 2.2, c: '#e8763a', halo: 'rgba(0,0,0,.55)' },
    national: { w: 1.6, c: '#f0a04a', halo: 'rgba(0,0,0,.45)' },
    provincial: { w: 1.0, c: 'rgba(255,246,214,.92)', halo: 'rgba(0,0,0,.38)' },
  };
  /* 道路名/编号的最小显示缩放。
   * 定这些阈值时踩过的坑：一开始高速名 1.0× 就出、国道 1.15×、省道 1.8×，
   * 结果 1× 时研究区中部（榆林—乌审旗一带）路网最密，几十个路名 + 编号
   * 挤成一团绿字，肉眼读不出任何一条 —— **注记密到一定程度就等于没有注记**。
   * 现在只在放大后逐级出现；且每级都带「只画本级与更粗」的判断，
   * 避免细级名字在高倍下糊成一片。 */
  const ROAD_LABEL_MIN = { expressway: 1.35, national: 1.8, provincial: 2.6 };

  function drawRoads(ctx, cw, ch, vs, X, Y, dpr) {
    const D = window.ROADS;
    if (!D) return;
    /* ⚠ dpr 陷阱（2026-10-03 修）：画布 backing store 是**设备像素**
     * （canvas.width = CSS 宽 × dpr），所以这里每个「屏幕像素常量」都要乘 dpr，
     * 否则 1.5× / 2× 屏上注记只有设计值的 1/1.5、1/2 ——
     * 2× 屏上写 13px 实际只有 6.5 CSS px，正是「地图文字好小」的真凶。
     * 下面凡是 `/ vs` 处（在 ctx.scale 里画），分子统一写成「CSS 像素 × dpr」。 */
    const DP = dpr || 1;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    /* 顺序：省道 → 国道 → 高速（粗的压细的） */
    for (const kind of ['provincial', 'national', 'expressway']) {
      const st = ROAD_STYLE[kind];
      const list = D[kind] || [];
      if (!list.length) continue;
      ctx.strokeStyle = st.c;
      ctx.lineWidth = st.w * DP / vs;
      ctx.beginPath();
      for (const f of list) {
        for (const run of f.p) {
          for (let i = 0; i < run.length; i++) {
            const x = X(lon2gx(run[i][0])), y = Y(lat2gy(run[i][1]));
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }

    /* 路名 + 国标编号。
     * 编号做成**绿底白字的小徽标**（对齐常见地图的国道编号牌），
     * 名字是橙色描边字。只在各自的最小缩放以上出现，否则 1× 时挤成一团。 */
    for (const kind of ['expressway', 'national', 'provincial']) {
      if (vs < ROAD_LABEL_MIN[kind]) continue;
      const list = D[kind] || [];
      if (!list.length) continue;
      const st = ROAD_STYLE[kind];
      /* 字号按 CSS 宽度算（再乘 dpr 换回设备像素）：上限受画布宽度约束，
       * 下限 11px 必须给足 —— 再小就糊成一团灰点，读不出是哪条路。 */
      const fs = clamp((cw / DP) / 64, 12, 15.5) * DP / vs;
      const n = ctx.measureText ? 0 : 0;   /* 占位：见下方逐条 measureText */
      ctx.font = `${fs.toFixed(2)}px "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = 'middle';
      for (const f of list) {
        if (!f.n) continue;
        const x = X(lon2gx(f.c[0])), y = Y(lat2gy(f.c[1]));
        /* 名与编号分两行：编号在下（像路侧编号牌），名在上 */
        if (f.r) {
          const bw = ctx.measureText(f.r).width + 6 * DP / vs;
          const bh = fs * 1.15;
          ctx.fillStyle = kind === 'provincial' ? 'rgba(28,110,60,.92)' : 'rgba(20,92,48,.92)';
          ctx.beginPath();
          roundRect(ctx, x - 3 * DP / vs, y + 2 * DP / vs, bw, bh, 2 * DP / vs);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 0.8 * DP / vs; ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.fillText(f.r, x, y + 2 * DP / vs + bh / 2);
        }
        ctx.fillStyle = kind === 'provincial' ? 'rgba(255,250,232,.95)' : '#ffd9a8';
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 3 * DP / vs;
        ctx.fillText(f.n, x, y - fs * 0.55);
        ctx.shadowBlur = 0;
      }
    }
  }

  /* 小圆角矩形（Path2D.roundRect 各家支持不一，自己画保证一致） */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* 注记与行政界的实际绘制（屏幕坐标系，见调用处注释） */
  function drawLabels(ctx, cw, ch, view, layers, dpr) {
    const vs = view ? view.s : 1;
    const vx = view ? view.x : 0, vy = view ? view.y : 0;
    /* dpr 陷阱同 drawRoads：画布是设备像素，屏幕像素常量一律乘 dpr 再除 vs。 */
    const DP = dpr || 1;
    const X = (gx) => gx / MU_W * cw, Y = (gy) => gy / MU_H * ch;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(vx, vy);
    ctx.scale(vs, vs);   /* 位置随 view 走；线宽字号下面手动除回来 */
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    /* ---- 6a. 道路网（roads.js）----
     * 放在地名之前画：路是底注记，地名压在路上才对。 */
    if (layers.roads) drawRoads(ctx, cw, ch, vs, X, Y, DP);

    /* 注记在画布右（左）边缘时翻到点的另一侧，否则字会被裁掉半截
     * （实测 2× 屏上「神木」两个字只剩一个「神」）。 */
    const drawPlaceName = (name, x, y) => {
      const off = 6 * DP / vs;
      const w = ctx.measureText(name).width;
      const flip = (x + off + w) * vs + vx > cw - 4 * DP && (x - off - w) * vs + vx > 4 * DP;
      /* 翻转要配 textAlign='right'，否则「往左放」变成从 x-off 往右画，
       * 既压住圆点又照样出界（这就是早先翻了但字还是被裁的原因）。 */
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.fillText(name, flip ? x - off : x + off, y - off);
      ctx.textAlign = 'left';
    };

    /* ---- 6b. 地名（原有图层，移到变换外） ----
     * 字号按 **CSS 宽度** 算再乘 dpr：目标是 12—16 CSS px。
     * （以前直接拿设备像素的 cw 去 clamp 上限 13，2× 屏上只有 6.5 CSS px。）
     * 偏移、点径、线宽、阴影同理全部乘 dpr。 */
    if (layers.places) {
      const fs = clamp((cw / DP) / 56, 13.5, 16.5) * DP / vs;
      ctx.font = `${fs.toFixed(2)}px "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = 'middle';
      for (const p of GEO.places) {
        const x = X(lon2gx(p.lon)), y = Y(lat2gy(p.lat));
        const r = (p.size * 0.9 + 1.4 * DP) / vs;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill();
        ctx.strokeStyle = 'rgba(12,24,20,.75)'; ctx.lineWidth = DP / vs; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 4 * DP / vs;
        drawPlaceName(p.name, x, y);
      }
      ctx.shadowBlur = 0;
    }

    /* ---- 6c. 行政区划（geo.js） ---- */
    const G = window.GEOADM;
    if (G && layers.admin) {
      const order = vs >= ADM_LOD.county ? ['province', 'city', 'county']
        : vs >= ADM_LOD.city ? ['province', 'city']
          : ['province'];
      for (const kind of order) {
        const list = G[kind] || [];
        if (!list.length) continue;
        const st = admStyle(kind);
        ctx.strokeStyle = st.c;
        ctx.lineWidth = st.w * DP / vs;
        ctx.setLineDash(st.dash.map((d) => d / vs));
        ctx.beginPath();
        for (const f of list) {
          for (const ring of f.r) {
            for (let i = 0; i < ring.length; i++) {
              const x = X(lon2gx(ring[i][0])), y = Y(lat2gy(ring[i][1]));
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
          }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      /* 县城注记：只在放大到县级后出现，避免小屏密密麻麻 */
      if (vs >= ADM_LOD.county) {
        const fs = clamp((cw / DP) / 62, 12.5, 15.5) * DP / vs;
        ctx.font = `${fs.toFixed(2)}px "Microsoft YaHei", sans-serif`;
        ctx.textBaseline = 'middle';
        for (const f of (G.county || [])) {
          const x = X(lon2gx(f.c[0])), y = Y(lat2gy(f.c[1]));
          ctx.fillStyle = 'rgba(255,255,255,.92)';
          ctx.beginPath(); ctx.arc(x, y, 2.4 * DP / vs, 0, Math.PI * 2); ctx.fill();
          ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4 * DP / vs;
          drawPlaceName(f.name, x, y);
        }
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }

  /* 本地行政矢量只提供位置参照，不提高 NDVI 栅格的观测分辨率。 */
  const ADM_LOD = { city: 1.15, county: 2.0 };

  /* 线宽/字号按**屏幕像素**给，不再除任何缩放系数。
   * 因为 drawLabels 已经画在 view 变换之外（见调用处注释），
   * 这里给的就是用户实际看到的粗细 —— 1× 和 8× 一样清楚。
   * 分级要拉开：省界最粗最亮、地市中等、县界最细最淡，
   * 否则三层叠在一起分不出谁是谁（实测：县界 1.3px 淡白 vs 省界 3.2px 亮金，
   * 在底图上确实能分辨，但再靠近就糊在一起了）。 */
  function admStyle(kind) {
    if (kind === 'province') return { w: 2.4, c: 'rgba(255,226,160,.95)', dash: [] };
    if (kind === 'city') return { w: 1.6, c: 'rgba(232,190,110,.85)', dash: [7, 5] };
    return { w: 1.1, c: 'rgba(255,250,238,.58)', dash: [4, 4] };
  }

  /* ======================================================================
   * 二、全球对照渲染器（共用小型栅格管线）
   * ==================================================================== */
  function paintGrid(canvas, gw, gh, fn) {
    const c = canvas.__grid && canvas.__grid.width === gw ? canvas.__grid : mkGrid(gw, gh);
    canvas.__grid = c;
    const g = c.getContext('2d');
    const img = g.createImageData(gw, gh);
    const d = img.data;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const [r, gg, b] = fn(x, y, i);
        const o = i * 4;
        d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c, 0, 0, canvas.width, canvas.height);
  }

  /* ---- 咸海：湖泊水位下降 → 湖底裸露为盐漠 ---- */
  const ARAL = { W: 168, H: 112, ready: false };
  function buildAral() {
    const n = makeNoise2D(404);
    const depth = new Float32Array(ARAL.W * ARAL.H);
    const tex = new Float32Array(ARAL.W * ARAL.H);
    /* 两个盆地：西咸海（较深、窄）+ 东咸海（较浅、宽），中间有窄颈 */
    const basins = [
      { cx: 0.38, cy: 0.46, rx: 0.16, ry: 0.34, d: 1.00 },
      { cx: 0.62, cy: 0.40, rx: 0.22, ry: 0.26, d: 0.86 },
      { cx: 0.47, cy: 0.44, rx: 0.07, ry: 0.10, d: 0.92 },
    ];
    for (let y = 0; y < ARAL.H; y++) {
      for (let x = 0; x < ARAL.W; x++) {
        const i = y * ARAL.W + x;
        const nx = x / ARAL.W, ny = y / ARAL.H;
        tex[i] = fbm(n, nx * 8, ny * 8, 3);
        let dd = 0;
        for (const b of basins) {
          const r = Math.hypot((nx - b.cx) / b.rx, (ny - b.cy) / b.ry);
          dd = Math.max(dd, (1 - r) * b.d);
        }
        dd += (fbm(n, nx * 16 + 7, ny * 16 + 3, 2) - 0.5) * 0.16;
        depth[i] = clamp(dd, 0, 1);
      }
    }
    ARAL.depth = depth; ARAL.tex = tex; ARAL.ready = true;
  }
  function renderAral(canvas, year) {
    if (!ARAL.ready) buildAral();
    const yi = year - window.DATA.YEAR_START;
    const area = window.DATA.GLOBAL_SERIES.aral[yi];
    const area0 = window.DATA.GLOBAL_SERIES.aral[0];
    const frac = clamp(area / area0, 0.02, 1);
    /* 二分求水位，使"水域面积占比"严格等于数据值 */
    let lo = 0, hi = 1;
    for (let k = 0; k < 22; k++) {
      const mid = (lo + hi) / 2;
      let cnt = 0;
      for (let i = 0; i < ARAL.depth.length; i++) if (ARAL.depth[i] > mid) cnt++;
      (cnt / ARAL.depth.length > frac) ? (lo = mid) : (hi = mid);
    }
    const L = (lo + hi) / 2;
    paintGrid(canvas, ARAL.W, ARAL.H, (x, y, i) => {
      const dep = ARAL.depth[i], t = ARAL.tex[i];
      if (dep > L) {
        const dpt = clamp((dep - L) / 0.55, 0, 1);
        return [lerp(96, 18, dpt), lerp(158, 62, dpt), lerp(186, 108, dpt)];
      }
      if (dep > L - 0.085) {
        /* 新裸露盐漠 */
        const s = 0.55 + t * 0.3;
        return [214 * s + 26, 198 * s + 24, 168 * s + 22];
      }
      /* 周边陆地 */
      const s = 0.72 + t * 0.26;
      return [176 * s, 146 * s, 106 * s];
    });
  }

  /* ---- 亚马逊：沿公路网的"鱼骨状"砍伐扩张 ---- */
  const AMZ = { W: 176, H: 116, ready: false };
  function segDistAll(x, y) {
    let best = 1e9;
    for (const s of AMZ.segs) {
      const [x1, y1, x2, y2] = s;
      const dx = x2 - x1, dy = y2 - y1;
      const l2 = dx * dx + dy * dy || 1e-6;
      let t = clamp(((x - x1) * dx + (y - y1) * dy) / l2, 0, 1);
      const px = x1 + dx * t, py = y1 + dy * t;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  function buildAmazon() {
    const n = makeNoise2D(505);
    const roads = [
      [[0.04, 0.22], [0.30, 0.30], [0.62, 0.26], [0.96, 0.34]],
      [[0.16, 0.88], [0.34, 0.60], [0.52, 0.32], [0.60, 0.06]],
      [[0.86, 0.10], [0.70, 0.42], [0.58, 0.72], [0.50, 0.98]],
    ];
    const segs = [];
    const pushSeg = (a, b) => segs.push([a[0] * AMZ.W, a[1] * AMZ.H, b[0] * AMZ.W, b[1] * AMZ.H]);
    for (const r of roads) {
      for (let k = 0; k < r.length - 1; k++) {
        const [x1, y1] = r[k], [x2, y2] = r[k + 1];
        pushSeg(r[k], r[k + 1]);
        const len = Math.hypot(x2 - x1, y2 - y1);
        const stepN = Math.max(2, Math.round(len / 0.045));
        for (let s = 0; s <= stepN; s++) {
          const t = s / stepN;
          const px = x1 + (x2 - x1) * t, py = y1 + (y2 - y1) * t;
          const nx = -(y2 - y1) / (len || 1), ny = (x2 - x1) / (len || 1);
          const L = 0.052 * (0.6 + ((s * 37) % 10) / 10 * 0.8);
          pushSeg([px, py], [px + nx * L, py + ny * L]);
          pushSeg([px, py], [px - nx * L, py - ny * L]);
        }
      }
    }
    AMZ.segs = segs;
    const dist = new Float32Array(AMZ.W * AMZ.H);
    const veg = new Float32Array(AMZ.W * AMZ.H);
    for (let y = 0; y < AMZ.H; y++) {
      for (let x = 0; x < AMZ.W; x++) {
        const i = y * AMZ.W + x;
        dist[i] = segDistAll(x, y);
        veg[i] = fbm(n, x / AMZ.W * 11, y / AMZ.H * 11, 4);
      }
    }
    AMZ.dist = dist; AMZ.veg = veg; AMZ.ready = true;
  }
  function renderAmazon(canvas, year) {
    if (!AMZ.ready) buildAmazon();
    const yi = year - window.DATA.YEAR_START;
    const loss = window.DATA.GLOBAL_SERIES.amazon[yi];
    const l0 = window.DATA.GLOBAL_SERIES.amazon[0], l1 = window.DATA.GLOBAL_SERIES.amazon[window.DATA.GLOBAL_SERIES.amazon.length - 1];
    const u = clamp((loss - l0) / (l1 - l0), 0, 1);
    const reach = 1.4 + u * 11.5;
    paintGrid(canvas, AMZ.W, AMZ.H, (x, y, i) => {
      const dd = AMZ.dist[i], v = AMZ.veg[i];
      const clear = 1 - smoothstep(reach - 2.4, reach + 2.4, dd);
      /* 亚马逊主河道 */
      const river = Math.abs(y / AMZ.H - (0.62 + Math.sin(x / AMZ.W * 5.2) * 0.07));
      const isRiver = river < 0.022 + Math.sin(x / AMZ.W * 13) * 0.006;
      if (isRiver) return [58, 108, 138];
      const forest = [lerp(28, 62, v), lerp(84, 138, v), lerp(46, 76, v)];
      const bare = [lerp(150, 190, v), lerp(124, 158, v), lerp(84, 104, v)];
      return [lerp(forest[0], bare[0], clear), lerp(forest[1], bare[1], clear), lerp(forest[2], bare[2], clear)];
    });
  }

  /* ---- 撒哈拉南界：荒漠化风险带南移 ---- */
  const SAH = { W: 176, H: 116, ready: false };
  function buildSahara() {
    const n = makeNoise2D(606);
    const bnd = new Float32Array(SAH.W);
    const tex = new Float32Array(SAH.W * SAH.H);
    for (let y = 0; y < SAH.H; y++)
      for (let x = 0; x < SAH.W; x++)
        tex[y * SAH.W + x] = fbm(n, x / SAH.W * 13, y / SAH.H * 13, 4);
    for (let x = 0; x < SAH.W; x++)
      bnd[x] = fbm(n, x / SAH.W * 6 + 20, 3.5, 3);
    SAH.bnd = bnd; SAH.tex = tex; SAH.ready = true;
  }
  function renderSahara(canvas, year) {
    if (!SAH.ready) buildSahara();
    const yi = year - window.DATA.YEAR_START;
    const s = window.DATA.GLOBAL_SERIES.sahel[yi];
    const s0 = window.DATA.GLOBAL_SERIES.sahel[0], s1 = window.DATA.GLOBAL_SERIES.sahel[window.DATA.GLOBAL_SERIES.sahel.length - 1];
    const u = clamp((s - s0) / (s1 - s0), 0, 1);
    const shift = u * 0.19;
    paintGrid(canvas, SAH.W, SAH.H, (x, y, i) => {
      const ny = y / SAH.H;
      /* 尼罗河（细绿带） */
      const nile = Math.abs(x / SAH.W - (0.80 + Math.sin(ny * 3.1) * 0.03));
      const niger = Math.abs(x / SAH.W - (0.34 + Math.sin(ny * 4.2 + 1) * 0.05));
      const edge = 0.44 + shift + (SAH.bnd[x] - 0.5) * 0.12;
      const isDesert = ny < edge ? 1 - smoothstep(edge - 0.10, edge + 0.02, ny) : 0;
      const t = SAH.tex[i];
      const sand = [lerp(196, 226, t), lerp(172, 204, t), lerp(124, 158, t)];
      const green = [lerp(58, 122, t), lerp(104, 168, t), lerp(52, 84, t)];
      let c = [lerp(green[0], sand[0], isDesert), lerp(green[1], sand[1], isDesert), lerp(green[2], sand[2], isDesert)];
      if (nile < 0.008) c = [70, 130, 108];
      if (niger < 0.007 && ny > 0.62) c = [70, 130, 108];
      return c;
    });
  }

  /* ---- 北极海冰：9 月最小范围消退 ---- */
  const ARC = { W: 140, H: 140, ready: false };
  function buildArctic() {
    const n = makeNoise2D(707);
    const tex = new Float32Array(ARC.W * ARC.H);
    for (let y = 0; y < ARC.H; y++)
      for (let x = 0; x < ARC.W; x++)
        tex[y * ARC.W + x] = fbm(n, x / ARC.W * 7, y / ARC.H * 7, 4);
    ARC.tex = tex; ARC.ready = true;
  }
  function renderArctic(canvas, year) {
    if (!ARC.ready) buildArctic();
    const yi = year - window.DATA.YEAR_START;
    const ext = window.DATA.GLOBAL_SERIES.arctic[yi];
    const e0 = window.DATA.GLOBAL_SERIES.arctic[0];
    const u = clamp(ext / e0, 0.2, 1);
    const R = (0.30 + 0.28 * Math.sqrt(u)) * ARC.W * 0.5 * 2 / 2;
    const cx = ARC.W / 2, cy = ARC.H / 2;
    const maxR = ARC.W * 0.48;
    const r = maxR * (0.58 + 0.42 * Math.sqrt(u));
    paintGrid(canvas, ARC.W, ARC.H, (x, y, i) => {
      const dx = (x - cx) / maxR, dy = (y - cy) / maxR;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const wob = 0.055 * Math.sin(ang * 5 + 1.2) + 0.035 * Math.sin(ang * 9 + 2.7) + (ARC.tex[i] - 0.5) * 0.05;
      const rr = r / maxR + wob;
      if (d > 1.02) return [16, 24, 34];                     /* 图幅外 */
      if (d < rr) {
        const conc = clamp((rr - d) / 0.16, 0, 1);
        return [lerp(120, 244, conc), lerp(180, 252, conc), lerp(214, 255, conc)];
      }
      return [22, 52, 84];                                    /* 开阔水域 */
    });
  }

  /* ======================================================================
   * 三、首屏背景：沙 → 绿 的流场粒子
   * ==================================================================== */
  /* 首屏主视觉：真实影像铺底 + 薄雾状装饰细线
   * ---------------------------------------------------------------------------
   * 此前首屏是 220 条程序化细线 + 中央光晕，与全站最贵的一块资产（40 年真实
   * Landsat）完全脱节 —— 而首屏正是评委看到的第一屏。
   * 现在：真实影像存在则 cover 铺满，再压一层渐变压暗 + 暗角保证标题可读；
   * 影像不在（离线/未加载）则退回程序化暗底，**绝不把假底图标成真影像**——
   * 首屏角标的文字由本函数返回值决定，页面必须如实显示当前画的是什么。
   * 返回：'real' | 'synth'
   */
  const heroBase = { year: null, w: 0, h: 0, canvas: null };
  function heroCover(year, w, h) {
    const im = tryRealImage(year);
    if (!im || !im.naturalWidth) return null;
    if (heroBase.canvas && heroBase.year === year && heroBase.w === w && heroBase.h === h) {
      return heroBase.canvas;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    const scale = Math.max(w / im.naturalWidth, h / im.naturalHeight);
    const dw = im.naturalWidth * scale, dh = im.naturalHeight * scale;
    cx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
    heroBase.year = year; heroBase.w = w; heroBase.h = h; heroBase.canvas = c;
    return c;
  }

  function renderHero(canvas, t) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const base = heroCover(window.DATA.YEAR_START, w, h);
    if (base) {
      ctx.drawImage(base, 0, 0);
      /* 压暗：上下端重、中段透 —— 纹理要看得见，标题才不会糊在亮底上。
       * 与 CSS .hero-veil 是两层叠加，改这一处前先看 main.css 的 hero-veil，
       * 两处一起调（此前两层都按「纯程序化底」的重度压暗写，影像等于没铺）。 */
      const vg = ctx.createLinearGradient(0, 0, 0, h);
      vg.addColorStop(0, 'rgba(7,13,11,.62)');
      vg.addColorStop(0.46, 'rgba(7,13,11,.16)');
      vg.addColorStop(1, 'rgba(7,13,11,.78)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
      /* 中央再补一层薄压暗，保证标题对比度；边缘留亮，沙丘纹理才认得出 */
      const rg = ctx.createRadialGradient(
        w * 0.5, h * 0.5, 0,
        w * 0.5, h * 0.5, Math.max(w, h) * 0.62);
      rg.addColorStop(0, 'rgba(7,13,11,.30)');
      rg.addColorStop(0.55, 'rgba(7,13,11,.06)');
      rg.addColorStop(1, 'rgba(7,13,11,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#0b1410'); g.addColorStop(1, '#050a09');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }

    /* 装饰细线：降为薄雾层（此前 220 条/alpha 0.19 会盖住真实地物） */
    const rnd = mulberry32(9);
    const N = 90;
    for (let i = 0; i < N; i++) {
      const bx = rnd() * w, by = rnd() * h;
      const ph = rnd() * Math.PI * 2, sp = 0.25 + rnd() * 0.7;
      const len = 26 + rnd() * 90;
      const x = (bx + t * sp * 26) % (w + 120) - 60;
      const yy = by + Math.sin(t * 0.6 + ph) * 12;
      const greenish = (by / h) > 0.45;
      const a = 0.025 + rnd() * 0.05;
      ctx.strokeStyle = greenish ? `rgba(96,198,118,${a})` : `rgba(214,182,116,${a})`;
      ctx.lineWidth = 0.6 + rnd() * 1.0;
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + len, yy + Math.sin(t + ph) * 6);
      ctx.stroke();
    }
    return base ? 'real' : 'synth';
  }

  /* 全球对照四图的统一暗角 —— 与首屏、主图同一套影调。
   * 此前这四张是纯程序化色块，和左侧真实 Landsat 同屏时质感落差很明显：
   * 真影像有纹理和明暗层次，色块是平的。统一加暗角 + CSS 微调后不再"跳"。 */
  function vignette(canvas, strength) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    const a = strength == null ? 0.46 : strength;
    const g = ctx.createRadialGradient(
      w * 0.5, h * 0.46, Math.min(w, h) * 0.16,
      w * 0.5, h * 0.46, Math.max(w, h) * 0.62);
    g.addColorStop(0, 'rgba(7,13,11,0)');
    g.addColorStop(1, `rgba(7,13,11,${a})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  window.RENDER = {
    renderMuUs, renderAral, renderAmazon, renderSahara, renderArctic, renderHero,
    vignette,
    ndviColor, MU_W, MU_H, lon2gx, lat2gy,
    tryRealImage,
    /* 当年高清贴图**已经在浏览器里了**（缓存命中/本轮看过）就返回 true。
     * 播放时据此决定是否还需要压低分辨率：已经拿到的高清图直接顶上，
     * 只有真正没下载的年份才走图集降采样层。 */
    realImageLoaded: (y) => realImgs[y] != null,
    /* stretch 是屏幕设备像素 / 导出图像像素，不是 Landsat 原生分辨率。 */
    lastStretch: () => lastStretchVal,
    bareNDVI: BARE_NDVI,
    imageState, retryRealImage, retryProbeCube,
    colorToNDVI, annualColorToNDVI,
    bareStats: (year) => {
      const mask = bareMask(year);
      if (!mask) return null;
      let bare = 0, non = 0, inv = 0, edge = 0;
      const data = mask.data;
      for (let y = 0; y < mask.height; y++) {
        for (let x = 0; x < mask.width; x++) {
          const index = y * mask.width + x;
          if (data[index] === 255) { inv++; continue; }
          if (data[index] === 0) { non++; continue; }
          bare++;
          if (x === 0 || y === 0 || x === mask.width - 1 || y === mask.height - 1
            || data[index - 1] !== 1 || data[index + 1] !== 1
            || data[index - mask.width] !== 1 || data[index + mask.width] !== 1) edge++;
        }
      }
      return { bare, non, inv, edge, total: data.length, width: mask.width, height: mask.height };
    },
    /* C2 点查：走图集（1.5 MB 一次）而不是逐年拉 40 张（23.9 MB） */
    preloadYears, loadProbeCube, probeCube, probeCubeState, onProbeCubeReady,
    cubeLayer, lastLayerKind,
    PROBE_GRID: { w: MU_W, h: MU_H, cols: CUBE_COLS, url: CUBE_URL },
  };
})();
