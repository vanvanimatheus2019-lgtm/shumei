/* ==========================================================================
 * sand.js —— 点击反馈：沙粒从**被按下的那颗按钮处**往下淌
 * --------------------------------------------------------------------------
 * 触发点：导览按钮（▶ 导览 / 三分钟导览）、顶栏「时间轴行进」、吸底时间轴的播放键。
 * 语义：按钮被按下的那一震，把它身上那层沙震松了 —— **沙粒从按钮自己那块矩形里
 * 出发、往下淌**，不是全屏统一从天上洒下来。
 *
 * 两处硬要求（都是你当面提过的，别改回去）：
 *   ① 颜色统一为沙黄**一个色**，不再掺暗褐 / 暖白 / 新绿；
 *   ② 发射源是按钮本身（getBoundingClientRect），按钮有多宽沙就铺多宽，
 *      起点在按钮这一带、向下走 —— 统一从屏幕上方掉落会「不像按钮在掉沙」。
 *
 * 为什么做成「独立一层固定 canvas」而不是把沙粒画进地图 canvas：
 *   1. 地图 canvas 有自己的 dpr 缩放与重绘节奏，塞粒子进去会拖累它（地图是重负载）；
 *   2. 这三个按钮分布在页面不同位置（顶栏 / 首屏 / 吸底胶囊），粒子要能盖住整屏，
 *      画在地图里没地方放；
 *   3. 这一层 `pointer-events:none`，**不抢任何点击** —— 装饰层不能反过来挡住它
 *      要装饰的那些按钮。
 *
 * 约束（改之前先看）：
 *   · 零外部依赖、断网可跑，与全站一致。
 *   · 粒子是有寿命的：出屏即回收、下半屏渐隐，循环在最后一个粒子消失时**主动停掉**
 *     （rAF 空转是发热和耗电的来源，别留常驻定时器）。
 *   · 非浏览器环境（jsdom 冒烟）没有 getContext 就直接整体退出，**绝不能抛错** ——
 *     冒烟是在页面脚本里跑的，这里一抛，后面所有断言跟着一起红。
 *   · prefers-reduced-motion 下只留一点点（16 粒）而不是完全没反馈：
 *     完全没反馈等于「点了没反应」，那正是本作品明令禁止的装饰性死节点。
 * ========================================================================== */
window.SAND = (function () {
  'use strict';

  var TAU = Math.PI * 2;
  var cv = null, ctx = null, dpr = 1, vw = 0, vh = 0;
  var grains = [], raf = 0, last = 0;

  /* 配色：统一一个沙黄。不再做「沙黄/土黄/暗褐/暖白 + 掺新绿」的杂色 ——
   * 混色看着像灰扑扑的土渣，而且绿点会抢走「绿进沙退」的叙事。深浅层次改由
   * 透明度（a）和尺寸（s）来做，粒子更小、更稀，才像**沙**不像彩纸屑。 */
  var PALETTE = ['#f0ce7e'];

  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }
  function pick() { return PALETTE[(Math.random() * PALETTE.length) | 0]; }

  function resize() {
    vw = window.innerWidth || 1024;
    vh = window.innerHeight || 768;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(vw * dpr);
    cv.height = Math.round(vh * dpr);
    cv.style.width = vw + 'px';
    cv.style.height = vh + 'px';
  }

  /* 懒创建：只有真的点了才建节点，首屏一个多余元素都不加 */
  function ensure() {
    if (cv) return true;
    try {
      if (!window.document || !window.document.createElement) return false;  /* 非浏览器环境 */
      cv = window.document.createElement('canvas');
      cv.id = 'sandLayer';
      cv.setAttribute('aria-hidden', 'true');       /* 纯装饰，别让读屏念出来 */
      cv.style.position = 'fixed';
      cv.style.top = '0'; cv.style.left = '0';
      cv.style.pointerEvents = 'none';             /* 关键：绝不挡点击 */
      cv.style.zIndex = '230';                     /* 压过导览(210)/溯源浮层(215) */
      window.document.body.appendChild(cv);
      ctx = cv.getContext('2d');
      if (!ctx) { cv = null; return false; }       /* 没有 2D 上下文就整体退成空实现 */
      /* 能力自检：少一个接口就别画。宁可不放特效，也不能让一个装饰层把整页拖崩 */
      if (!ctx.save || !ctx.translate || !ctx.rotate || !ctx.scale || !ctx.arc || !ctx.fill) {
        cv = null; ctx = null; return false;
      }
      resize();
      if (window.addEventListener) {
        window.addEventListener('resize', function () { if (cv) resize(); }, { passive: true });
      }
      return true;
    } catch (e) { cv = null; ctx = null; return false; }
  }

  function jolt(el) {
    if (!el || !el.classList) return;
    el.classList.remove('btn-jolt');
    /* 读一次 offsetWidth 强制回流：不然连续两次点击时浏览器会把动画合并掉，
       第二次点就没反应了 */
    void el.offsetWidth;
    el.classList.add('btn-jolt');
    clearTimeout(el._joltT);
    el._joltT = setTimeout(function () { el.classList.remove('btn-jolt'); }, 320);
  }

  function tick(ts) {
    raf = 0;
    var dt = last ? Math.min(0.034, (ts - last) / 1000) : 0.016;   /* 卡帧时钳住，别让粒子瞬移 */
    last = ts;
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    if (!grains.length) { last = 0; return; }

    var keep = [];
    for (var i = 0; i < grains.length; i++) {
      var g = grains[i];
      g.vy += 1500 * dt;                 /* 重力：沙粒不是雨滴，落得实 */
      g.vx -= g.vx * 0.9 * dt;           /* 空气阻力 */
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.rot += g.vr * dt;
      if (g.y > vh + 14) continue;       /* 出屏回收 */

      var a = g.a;
      var fade = (g.y - vh * 0.55) / (vh * 0.45);   /* 下半屏渐隐，别硬生生砸在底边 */
      if (fade > 0) a = a * (1 - fade);
      if (a <= 0.02) continue;

      var sp = Math.min(1, Math.abs(g.vy) / 900);
      ctx.globalAlpha = a;
      ctx.fillStyle = g.c;
      /* 沿运动方向拉长一点：有速度感才像"淌"而不是"飘"。
       * 用 scale 拉而不是 ctx.ellipse —— 前者是 ES5 时代就有的老接口，
       * 冒烟里那套 Canvas 桩件没实现 ellipse，一调就抛、整轮断言跟着红。 */
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.rot);
      ctx.scale(1, 0.55 + sp * 1.15);
      ctx.beginPath();
      ctx.arc(0, 0, g.s / 2, 0, TAU);
      ctx.fill();
      ctx.restore();
      keep.push(g);
    }
    ctx.globalAlpha = 1;
    grains = keep;
    if (grains.length) raf = requestAnimationFrame(tick);
    else last = 0;                       /* 收工，不留常驻定时器 */
  }

  function start() { if (!raf && ctx) raf = requestAnimationFrame(tick); }

  /* 抖落一片沙：**起点在被按下的那颗按钮上**。
     物理上写成「按钮被震了一下，它身上那层沙松了、顺着往下淌」：
     粒子沿按钮矩形的横向 + 纵向铺开出生，带一点向外的初速，重力把它们拉下去。
     opts: { count:n, x:cx, y:cy, band:px } —— 不传 el 时按 x / y（视口坐标）定位。
     注意：这里**不能**再把出生点推到屏幕上方（y:-6）去，那样变成全屏统一「天落沙」，
     看不出是哪颗按钮在响。 */
  function puff(el, opt) {
    var o = opt || {};
    var count = o.count || 62;
    jolt(el);
    if (!ensure()) return 0;
    if (reduced() && count > 16) count = 16;

    var r = (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : null;
    /* 视口坐标下的按钮中心与半宽；没给 el 就退到程序给的 x / y */
    var cx = (typeof o.x === 'number') ? o.x : (r ? r.left + r.width / 2 : vw / 2);
    var cy = (typeof o.y === 'number') ? o.y : (r ? r.top + r.height / 2 : vh * 0.4);
    var halfW = (typeof o.band === 'number') ? o.band / 2 : (r ? r.width / 2 + 12 : 160);
    var halfH = r ? r.height * 0.5 + 8 : 44;              /* 起点铺满按钮那一块 */
    var spread = r ? Math.min(72, 26 + r.width * 0.16) : 60;   /* 向两侧散开的幅度 */

    for (var i = 0; i < count; i++) {
      grains.push({
        x: cx + (Math.random() * 2 - 1) * halfW,
        y: cy + (Math.random() * 2 - 1) * halfH,
        vx: (Math.random() * 2 - 1) * spread,             /* 先往外一弹，再被重力带走 */
        vy: 26 + Math.random() * 92,                      /* 一出生就朝下 —— 是"淌"不是"飘" */
        s: 1.2 + Math.random() * 2.1,                     /* 沙粒尺寸：小，别做成雪片 */
        rot: Math.random() * TAU,
        vr: (Math.random() * 2 - 1) * 5,
        c: pick(),
        a: 0.45 + Math.random() * 0.45,
      });
    }
    /* 连点保护：上限 260，超了就把最早的丢掉（旧的本来也快出屏了） */
    if (grains.length > 260) grains.splice(0, grains.length - 260);
    start();
    return grains.length;
  }

  return {
    puff: puff,
    /* 给测试用的只读探针：当前粒子数 / 用到的颜色种类 / 出生点范围 / 画布在不在 / 会不会挡点击 */
    stat: function () {
      var cols = {}, n = 0, y0 = Infinity, y1 = -Infinity;
      for (var i = 0; i < grains.length; i++) {
        var g = grains[i];
        cols[g.c] = 1; n++;
        if (g.y < y0) y0 = g.y;
        if (g.y > y1) y1 = g.y;
      }
      return {
        n: n,
        colors: Object.keys(cols),
        yMin: n ? y0 : null,
        yMax: n ? y1 : null,
        canvas: !!cv,
        blocking: !!(cv && /auto|all/.test(window.getComputedStyle ? window.getComputedStyle(cv).pointerEvents : 'none')),
      };
    },
  };
})();
