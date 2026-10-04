/* 情绪色彩与出场动画。
 * 每一节对应一个 --mood 值（0 = 沙，1 = 绿），滚动时在相邻两节之间平滑过渡；
 * 页面底色的两团环境光（immersive.css）随之此消彼长。 */
(function () {
  const ANCHORS = [
    ['#opening', 0.05], ['#hero', 0.15], ['#prologue', 0.1], ['#story', 0.05],
    ['#beforeafter', 0.35], ['#stage', 0.6], ['#today', 1], ['#panel', 0.9],
    ['#method', 0.75], ['#about', 0.75],
  ];
  const root = document.documentElement;
  let ticking = false;

  /* 右侧章节导航：一眼看到整部作品有几章、现在读到哪 */
  const CHAPTERS = [
    ['#opening', '开场'], ['#hero', '同一块地'], ['#prologue', '沙 · 治 · 绿'], ['#story', '治沙人'],
    ['#beforeafter', '怎么治'], ['#stage', '四十年'], ['#today', '今天'], ['#panel', '数据'],
    ['#method', '方法'], ['#about', '来源'],
  ];
  const rail = document.createElement('nav');
  rail.className = 'chapter-rail';
  rail.setAttribute('aria-label', '章节');
  rail.innerHTML = CHAPTERS.map(([selector, label], i) =>
    '<a href="' + selector + '" data-i="' + i + '"><span class="cr-label">' + label + '</span><i></i></a>').join('');
  document.body.appendChild(rail);
  const railLinks = Array.from(rail.querySelectorAll('a'));
  rail.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  function updateRail(mid) {
    let active = 0;
    CHAPTERS.forEach(([selector], i) => {
      const element = document.querySelector(selector);
      if (element && element.offsetParent !== null && element.getBoundingClientRect().top <= mid) active = i;
    });
    railLinks.forEach((link, i) => link.classList.toggle('on', i === active));
    rail.classList.toggle('dark', active === 0);
  }

  function update() {
    ticking = false;
    const mid = innerHeight * 0.5;
    const points = ANCHORS.map(([selector, mood]) => {
      const element = document.querySelector(selector);
      if (!element || element.offsetParent === null) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, mood };
    }).filter(Boolean);
    if (!points.length) { updateRail(mid); return; }
    let mood = points[0].mood;
    for (let i = 0; i < points.length; i++) {
      if (points[i].top <= mid) {
        mood = points[i].mood;
        const next = points[i + 1];
        if (next && next.top > mid) {
          const span = next.top - points[i].top || 1;
          mood += (next.mood - points[i].mood) * Math.min(1, Math.max(0, (mid - points[i].top) / span));
        }
      }
    }
    root.style.setProperty('--mood', mood.toFixed(3));
    updateRail(mid);
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener('resize', update);
  addEventListener('load', update);
  update();

  /* 出场动画 */
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const selector = '.sec-head,.pro-card,.prologue-lede,.story-stat,.story-intro,.person-moment,.mechanism-card,.mechanism-note,.phase-block,.map-card,.global-card,.local-process-block,.region-grid,.today-grid,.today-subhead,.story,.chart-card,.pull-quote,.main-quote,.static-card,.insight-card,.pl-claim,.global-scale,.people-lede';
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in');
    observer.unobserve(entry.target);
  }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  function arm() {
    document.querySelectorAll(selector).forEach((element, index) => {
      if (element.classList.contains('reveal')) return;
      element.classList.add('reveal');
      element.style.transitionDelay = (index % 4) * 70 + 'ms';
      observer.observe(element);
    });
  }
  /* 人物卡、时间线是脚本生成的，等页面脚本跑完再挂。 */
  addEventListener('load', () => setTimeout(arm, 200));
})();
