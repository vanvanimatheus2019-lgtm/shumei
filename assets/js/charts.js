/* ==========================================================================
 * charts.js  ·  轻量 SVG 图表（零外部依赖）
 * 支持：折线 + 面积 / 柱状；可随时间轴联动高亮当前年份
 * ========================================================================== */
/* ==========================================================================
 * 联动游标（2026-10-03 新增）
 * --------------------------------------------------------------------------
 * 需求：拖任意一张图的年份游标，其余所有图的游标跳到同一年 ——
 * 用来「横向比读同一年各指标」（比如 2000 年 NDVI 多少、沙尘日数多少）。
 *
 * 实现要点：
 *  1. **单一游标**：CUR 只有一份，图表各自只是它的视图。谁拖都emit同一份，
 *     不搞「互相通知」—— 那种写法会在 8 张图上产生 8 次重排且难保证同帧。
 *  2. 拖拽用 **setPointerCapture**：指针滑到图外也不断（不 then 就得在
 *     svg 上再补 pointerup/leave，滑快了会丢事件）。
 *  3. 读数是**各图自己的数**（跨序列不能共用一个值），所以 emit 只发「年份下标」，
 *     具体数值由每张图自己取 —— 这也是「同一个游标、不同读数」的正确形态。
 * ========================================================================== */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const { YEARS } = window.DATA;

  const REG = [];        /* 所有已构建的 Chart（resize 会重建，重建前先摘掉旧的） */
  let CUR = 0;           /* 联动游标：年份下标（全站图表共用一个） */
  const subs = [];       /* 外部订阅（app.js 靠它把年份回写到全站时间） */
  const drags = [];      /* 拖拽起止订阅（app.js 靠它开/关「拖动期」省流量策略） */
  let dragging = false;  /* 当前是否有人正按着某张图（多指/双图同时按时以最后按下的为准） */

  /* 游标只有一个真身：所有图表只是它的视图。谁拖都走这里，
   * 一次遍历全部同步 —— 不搞「A 通知 B、B 再通知 C」的互相回调。
   *
   * src 的语义（**别当成调试信息删掉**，app.js 靠它防递归）：
   *   src === null  → 外部程序设的（如时间轴驱动 setCursor），**不要**再回写年份，
   *                   否则 setYear → drawCharts → setCursor → emit → setYear 成死循环；
   *   src === Chart → 用户在拖这张图，应该驱动全站时间。 */
  function emitCursor(i, src) {
    const n = YEARS.length - 1;                       /* 上限永远按年份表来，不看单张图的数据长度 */
    i = Number.isFinite(i) ? Math.max(0, Math.min(n, Math.round(i))) : CUR;
    CUR = i;
    REG.forEach((ch) => ch.setIndex(i));
    subs.forEach((fn) => { try { fn(i, src); } catch (e) { /* 订阅者自己炸别拖垮图表 */ } });
  }

  /* 拖拽起止通知。app.js 要在拖动期切到图集预览（40 张高清图 25 MB，
   * 一次快速拖过 40 年就是 25 MB 请求），松手再把当年高清补上。
   * 键盘微调**不算拖拽** —— 一次只挪一年，逐个拉高清完全负担得起。 */
  function emitDrag(on, i) {
    if (dragging === on) return;      /* 重复通知（两图同时按）不重复广播 */
    dragging = on;
    drags.forEach((fn) => { try { fn(on, i); } catch (e) { } });
  }

  function niceTicks(min, max, n) {
    const span = (max - min) || 1;
    const raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step;
    const out = [];
    for (let v = lo; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  class Chart {
    constructor(el, opts) {
      this.el = el;
      this.o = Object.assign({
        type: 'line', color: '#4ec97a', data: [], unit: '', decimals: 1,
        yMin: null, yMax: null, tickCount: 4, label: '', observed: null,
        /* 「拖我」的提示只挂第一张图，八张都写提示反而看着像八种功能 */
        draggable: false,
      }, opts);
      const dataset = Object.values(window.DATA.MU_US || {}).find((series) => series.values === this.o.data);
      this.o.status = dataset ? dataset.status : this.o.status;
      this.o.demonstration = dataset ? dataset.grade === 'B' : Boolean(this.o.demonstration);
      if (this.o.demonstration) this.o.observed = null;
      /* 新图一出生就对齐当前游标：resize 重建（build 会重画 SVG）时不能
       * 把游标打回 1986 —— 否则拖到 2010 后 resize 一下，白线自己跳回起点。 */
      this.yearIdx = CUR;
      this.build();
    }

    build() {
      const o = this.o;
      this.el.dataset.drag = o.draggable ? '1' : '';   /* 给 CSS 一个抓手：可拖的图才换光标 */
      const w = this.el.clientWidth || 480;
      const h = this.el.clientHeight || 200;
      this.w = w; this.h = h;
      const pad = { l: 46, r: 14, t: o.status ? 30 : 16, b: 26 };
      this.pad = pad;
      const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;

      const d = o.data;
      let mn = o.yMin, mx = o.yMax;
      if (mn == null) mn = Math.min(...d);
      if (mx == null) mx = Math.max(...d);
      const padv = (mx - mn) * 0.12 || 1;
      mn = o.yMin != null ? o.yMin : Math.max(0, mn - padv);
      mx = mx + padv;
      if (o.type === 'bar') mn = Math.min(mn, 0);
      this.mn = mn; this.mx = mx;

      const X = (i) => pad.l + (i / (d.length - 1)) * iw;
      const Y = (v) => pad.t + ih - ((v - mn) / (mx - mn || 1)) * ih;
      this.X = X; this.Y = Y;

      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.style.overflow = 'visible';

      if (o.status) {
        const status = document.createElementNS(NS, 'text');
        status.setAttribute('x', w - 14); status.setAttribute('y', 13);
        status.setAttribute('text-anchor', 'end'); status.setAttribute('font-size', '10');
        status.setAttribute('fill', o.demonstration ? '#dabf8d' : '#91bea0');
        status.textContent = o.status + (o.demonstration ? ' · 非实测' : ' · 随附工程数据');
        svg.appendChild(status);
      }
      /* 网格 + Y 轴刻度 */
      const ticks = niceTicks(mn, mx, o.tickCount);
      ticks.forEach((t) => {
        const y = Y(t);
        if (y < pad.t - 2 || y > pad.t + ih + 2) return;
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('x1', pad.l); ln.setAttribute('x2', w - pad.r);
        ln.setAttribute('y1', y); ln.setAttribute('y2', y);
        ln.setAttribute('stroke', 'rgba(255,255,255,.12)');
        ln.setAttribute('stroke-dasharray', '3 4');
        svg.appendChild(ln);
        const tx = document.createElementNS(NS, 'text');
        tx.setAttribute('x', pad.l - 8); tx.setAttribute('y', y + 3.5);
        tx.setAttribute('text-anchor', 'end');
        tx.setAttribute('fill', 'rgba(226,238,232,.55)');
        tx.setAttribute('font-size', '10');
        tx.textContent = (+t).toFixed(Math.abs(t) < 10 ? o.decimals : 0);
        svg.appendChild(tx);
      });

      /* X 轴年份 */
      const stepY = Math.ceil(d.length / 7);
      YEARS.forEach((yr, i) => {
        if (i % stepY && i !== d.length - 1) return;
        if (i !== d.length - 1 && i % stepY === 0 && d.length - 1 - i < stepY * 0.6) return;
        const tx = document.createElementNS(NS, 'text');
        tx.setAttribute('x', X(i)); tx.setAttribute('y', h - 8);
        tx.setAttribute('text-anchor', 'middle');
        tx.setAttribute('fill', 'rgba(226,238,232,.5)');
        tx.setAttribute('font-size', '10');
        tx.textContent = yr;
        svg.appendChild(tx);
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('x1', X(i)); ln.setAttribute('x2', X(i));
        ln.setAttribute('y1', pad.t); ln.setAttribute('y2', pad.t + ih);
        ln.setAttribute('stroke', 'rgba(255,255,255,.06)');
        svg.appendChild(ln);
      });

      /* 数据 */
      if (o.type === 'line') {
        const pts = d.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
        const area = document.createElementNS(NS, 'polygon');
        area.setAttribute('points', `${X(0)},${Y(mn)} ${pts.join(' ')} ${X(d.length - 1)},${Y(mn)}`);
        area.setAttribute('fill', o.color);
        area.setAttribute('opacity', '.14');
        svg.appendChild(area);
        const path = document.createElementNS(NS, 'polyline');
        path.setAttribute('points', pts.join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', o.color);
        path.setAttribute('stroke-width', '2');
        if (o.demonstration) path.setAttribute('stroke-dasharray', '5 4');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
      } else {
        const bw = Math.max(2, iw / d.length * 0.62);
        d.forEach((v, i) => {
          const y0 = Y(Math.max(0, mn)), y1 = Y(v);
          const r = document.createElementNS(NS, 'rect');
          r.setAttribute('x', X(i) - bw / 2);
          r.setAttribute('y', Math.min(y0, y1));
          r.setAttribute('width', bw);
          r.setAttribute('height', Math.max(1, Math.abs(y1 - y0)));
          r.setAttribute('rx', Math.min(2, bw / 2));
          r.setAttribute('fill', o.color);
          r.setAttribute('opacity', i > this.yearIdx ? '.34' : '.85');
          r.dataset.idx = i;
          svg.appendChild(r);
        });
        this.bars = Array.from(svg.querySelectorAll('rect[data-idx]'));
      }

      /* 实测端点：画成空心圆，与内插段区分（避免把"公报实测"和"锚点插值"看成同一回事） */
      if (o.observed && o.observed.length) {
        o.observed.forEach((yr) => {
          const i = YEARS.indexOf(yr);
          if (i < 0 || o.data[i] == null) return;
          const c = document.createElementNS(NS, 'circle');
          c.setAttribute('cx', X(i)); c.setAttribute('cy', Y(o.data[i]));
          c.setAttribute('r', '3.6');
          c.setAttribute('fill', 'none');
          c.setAttribute('stroke', o.color);
          c.setAttribute('stroke-width', '1.8');
          svg.appendChild(c);
        });
      }

      /* 游标 */
      const cur = document.createElementNS(NS, 'line');
      cur.setAttribute('stroke', 'rgba(255,255,255,.5)');
      cur.setAttribute('stroke-width', '1');
      cur.setAttribute('y1', pad.t); cur.setAttribute('y2', pad.t + ih);
      svg.appendChild(cur);
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '4.2');
      dot.setAttribute('fill', o.color);
      dot.setAttribute('stroke', '#0d1512');
      dot.setAttribute('stroke-width', '2');
      svg.appendChild(dot);
      const tip = document.createElementNS(NS, 'text');
      tip.setAttribute('font-size', '11');
      tip.setAttribute('font-weight', '600');
      tip.setAttribute('fill', '#eafff0');
      svg.appendChild(tip);
      /* 数值标签的暗底（每帧复用同一个 <rect>，不重建 DOM） */
      const tipBack = document.createElementNS(NS, 'rect');
      tipBack.setAttribute('fill', 'rgba(8,16,13,.82)');
      tipBack.setAttribute('height', '16');
      tipBack.setAttribute('rx', '3');
      svg.insertBefore(tipBack, tip);
      this.cur = cur; this.dot = dot; this.tip = tip; this.tipBack = tipBack;

      this.el.innerHTML = '';
      this.el.appendChild(svg);
      this.svg = svg;
      this.setIndex(this.yearIdx);
      this.attachCursor();
    }

    /* ---------- 联动游标：拖这块图，全站图表跟着走 ---------- */
    attachCursor() {
      const k = REG.indexOf(this);
      if (k >= 0) REG.splice(k, 1);        /* resize 重建时先摘掉，别让注册表里躺着废图 */
      REG.push(this);
      const svg = this.svg, o = this.o, pad = this.pad;
      const n = o.data.length - 1;
      const iw = this.w - pad.l - pad.r;

      /* 指针 → 年份下标。svg 可能被 CSS 缩放过，
       * 所以要用 getBoundingClientRect 反算回 SVG 用户坐标，不能直接减像素。 */
      const idxAt = (e) => {
        const r = svg.getBoundingClientRect();
        if (!r.width) return CUR;                    /* 图还没排版出来（display:none），别乱跳 */
        const ux = (e.clientX - r.left) * (this.w / r.width);
        const x = ux - pad.l;
        return Math.max(0, Math.min(n, Math.round((x / iw) * n)));
      };

      if (o.draggable) {
        /* 命中区：铺满绘图区，指针落在曲线上、空白处都能拖 */
        const hitRect = document.createElementNS(NS, 'rect');
        hitRect.setAttribute('x', pad.l - 8);
        hitRect.setAttribute('y', pad.t);
        hitRect.setAttribute('width', iw + 16);
        hitRect.setAttribute('height', this.h - pad.t - pad.b);
        hitRect.setAttribute('fill', 'transparent');
        hitRect.setAttribute('data-cursor-hit', '');
        hitRect.style.cursor = 'ew-resize';
        svg.appendChild(hitRect);
      }

      let drag = false;
      svg.addEventListener('pointerdown', (e) => {
        if (!o.draggable) return;
        drag = true;
        try { svg.setPointerCapture(e.pointerId); } catch (_) { /* 老浏览器没有就算了 */ }
        this.el.classList.add('dragging');
        emitDrag(true, idxAt(e));
        emitCursor(idxAt(e), this);
        e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => { if (drag) emitCursor(idxAt(e), this); });
      const end = (e) => {
        if (!drag) return;
        drag = false;
        try { svg.releasePointerCapture(e.pointerId); } catch (_) { }
        this.el.classList.remove('dragging');
        /* 松手才通知结束：app.js 趁这个时机把停在哪一年的高清贴图补上。 */
        emitDrag(false, CUR);
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
      svg.setAttribute('tabindex', o.draggable ? '0' : '-1');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${o.label || '数据图'}，${o.status || '数列'}${o.draggable ? '；左右方向键可移动年份游标' : ''}`);
      svg.addEventListener('keydown', (e) => {
        if (!o.draggable) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault(); e.stopPropagation();      /* 别让方向键去动主时间轴 */
        emitCursor(CUR + (e.key === 'ArrowRight' ? 1 : -1), this);
      });
    }

    setIndex(i) {
      this.yearIdx = i;
      const o = this.o, v = o.data[i];
      const x = this.X(i), y = this.Y(v);
      this.cur.setAttribute('x1', x); this.cur.setAttribute('x2', x);
      this.dot.setAttribute('cx', x); this.dot.setAttribute('cy', y);
      const right = i > o.data.length * 0.72;
      this.tip.setAttribute('x', x + (right ? -8 : 8));
      this.tip.setAttribute('y', Math.max(this.pad.t + 10, y - 9));
      this.tip.setAttribute('text-anchor', right ? 'end' : 'start');
      /* 数值标签底下垫一层暗底：标签压在曲线和网格线上时（沙尘那张棕线最明显）
       * 纯白字读不清，读数看不清等于没读。 */
      const txt = `${YEARS[i]}  ${o.demonstration ? '示意 ' : ''}${Number.isFinite(v) ? v.toFixed(o.decimals) : '—'}${o.unit}`;
      if (this.tipTxt !== txt) {
        this.tipTxt = txt;
        this.tip.textContent = txt;
        const wpx = Math.max(36, txt.length * 6.2 + 8);
        const bx = right ? x - 8 - wpx : x + 8;
        this.tipBack.setAttribute('x', bx);
        this.tipBack.setAttribute('y', Math.max(2, y - 23));
        this.tipBack.setAttribute('width', wpx);
        this.tipBack.setAttribute('height', 16);
        this.tipBack.setAttribute('rx', 3);
        this.tipBack.setAttribute('fill', 'rgba(8,16,13,.82)');
        this.tipBack.setAttribute('stroke', 'rgba(255,255,255,.14)');
        this.tipBack.setAttribute('stroke-width', '1');
        this.svg.insertBefore(this.tipBack, this.tip);
      }
      if (this.bars) this.bars.forEach((b) => {
        b.setAttribute('opacity', +b.dataset.idx > i ? '.32' : '.88');
      });
    }

    resize() { this.build(); }

    /* 注销：resize / 重构建前必须调。
     * 不摘会把废图永久留在 REG 里 —— emitCursor 每次都要遍历它，
     * 拖一次八张图就变成拖十六张（八张是画在别的 SVG 上的死对象）。 */
    destroy() {
      const k = REG.indexOf(this);
      if (k >= 0) REG.splice(k, 1);
    }
  }

  /* -------- 中国 vs 全球 对比条 -------- */
  function buildCompareBars(el) {
    const rows = [
      { label: '中国占全球植被面积', v: 6.6, color: '#8fa3b0' },
      { label: '中国贡献全球净增叶面积', v: 25, color: '#4ec97a' },
    ];
    el.innerHTML = rows.map((r) => `
      <div class="cmp-row">
        <div class="cmp-label">${r.label}</div>
        <div class="cmp-track"><div class="cmp-fill" style="width:${r.v * 3}%;background:${r.color}"></div></div>
        <div class="cmp-val" style="color:${r.color}">${r.v}%</div>
      </div>`).join('');
  }

  window.CHARTS = {
    Chart,
    buildCompareBars,
    /* 外部用：
     *   setCursor(i)  —— 直接把游标挪到某年（不触发拖拽反馈）
     *   getCursor()   —— 读出当前游标年份
     *   onCursor(fn)  —— 订阅游标变化。fn(下标, src)，**src 为 null 表示外部程序设的**
     *                    （时间轴驱动），非 null 表示用户在拖某张图 —— 判断该不该回写
     *                    全站年份就靠它，不判断就会 setYear ↔ setCursor 死循环。
     *   onDrag(fn)    —— 订阅拖拽起止 fn(是否按下, 年份下标)，用于「拖动期走图集、
     *                    松手补当年高清」的流量策略。
     *   isDragging()  —— 当前是否正有人按着某张图（探针/调试用）
     *   charts()      —— 拿注册表（调试 / 测试用） */
    setCursor: (i) => emitCursor(i, null),
    getCursor: () => CUR,
    /* 订阅去重：buildCharts 会被 init + resize + load 各调一次，
     * 直接 push 会让同一个回调进三遍（拖一次刷三次 DOM）。 */
    onCursor: (fn) => { if (typeof fn === 'function' && !subs.includes(fn)) subs.push(fn); return fn; },
    onDrag: (fn) => { if (typeof fn === 'function' && !drags.includes(fn)) drags.push(fn); return fn; },
    isDragging: () => dragging,
    charts: () => REG.slice(),
  };
})();
