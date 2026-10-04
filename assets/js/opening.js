/* 开场短片：40 张年度 NDVI 图逐年淡入淡出，年份和区域植被指数跟着画面走。
 * 时间表与 tools/make_opening_video.py 一致：每年 4 帧停留 + 3 帧淡变，25 帧/秒。 */
(function () {
  const FPS = 25, FRAMES_PER_YEAR = 7, YEARS = 40;
  const $ = selector => document.querySelector(selector);
  const section = $('#opening');
  if (!section) return;
  const video = $('#openingVideo');
  const yearEl = $('#openingYear'), ndviEl = $('#openingNdvi'), phaseEl = $('#openingPhase');
  const bar = $('#openingBar');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const data = window.DATA;
  let lastIndex = -1, raf = 0;

  function showYear(index) {
    if (index === lastIndex) return;
    lastIndex = index;
    const year = 1986 + index;
    yearEl.textContent = year;
    ndviEl.textContent = data.MU_SERIES.ndvi[index].toFixed(3);
    const phase = (data.PHASES || []).find(item => year >= item.start && year <= item.end);
    phaseEl.textContent = phase ? phase.start + '—' + phase.end + ' · ' + phase.name : '';
    bar.style.setProperty('--progress', (index / (YEARS - 1) * 100).toFixed(2) + '%');
  }

  function indexAt(seconds) {
    const frame = Math.floor(seconds * FPS);
    return Math.max(0, Math.min(YEARS - 1, Math.floor((frame + 2) / FRAMES_PER_YEAR)));
  }

  function loop() {
    showYear(indexAt(video.currentTime));
    if (!video.paused && !video.ended) raf = requestAnimationFrame(loop);
  }

  function finish() {
    cancelAnimationFrame(raf);
    showYear(YEARS - 1);
    section.classList.add('is-done');
  }

  function play() {
    section.classList.remove('is-done');
    lastIndex = -1;
    video.currentTime = 0;
    const promise = video.play();
    if (promise && promise.catch) promise.catch(finish);
  }

  video.addEventListener('play', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
  video.addEventListener('ended', finish);
  video.addEventListener('error', finish);
  const sources = video.querySelectorAll('source');
  if (sources.length) sources[sources.length - 1].addEventListener('error', finish);
  $('#openingReplay').addEventListener('click', play);
  $('#openingSkip').addEventListener('click', () => {
    video.pause(); finish();
    $('#hero').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  });
  $('#openingNext').addEventListener('click', () => $('#hero').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }));

  /* 导航栏在开场画面上改成深色半透明。 */
  const observer = new IntersectionObserver(entries => {
    document.body.classList.toggle('over-opening', entries[0].isIntersecting && entries[0].intersectionRatio > 0.35);
  }, { threshold: [0, 0.35, 0.6] });
  observer.observe(section);

  if (reduced) { video.removeAttribute('autoplay'); video.pause(); finish(); return; }
  showYear(0);
  if (video.readyState >= 2) play();
  else video.addEventListener('canplay', () => { if (video.currentTime === 0 && video.paused) play(); }, { once: true });
})();

/* 数字滚动：元素第一次进入视野时，数字从 0 走到最终值，保留原来的小数位和单位。 */
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const pattern = /\d+(?:\.\d+)?/g;
  function animate(element) {
    /* 只改文字节点，保留 <small> 等标签。 */
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push([walker.currentNode, walker.currentNode.nodeValue]);
    const all = nodes.map(item => item[1]).join('');
    if (!/\d/.test(all) || all.includes('—')) return;
    const start = performance.now(), duration = 1300;
    const step = now => {
      const k = Math.min(1, (now - start) / duration), ease = 1 - Math.pow(1 - k, 3);
      nodes.forEach(([node, original]) => {
        node.nodeValue = k >= 1 ? original : original.replace(pattern, token => {
          const decimals = (token.split('.')[1] || '').length;
          const value = parseFloat(token);
          /* 年份这类四位整数不滚动，免得出现“0 年”。 */
          if (!decimals && value >= 1900 && value <= 2100) return token;
          return (value * ease).toFixed(decimals);
        });
      });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function watch() {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      animate(entry.target);
    }), { threshold: 0.6 });
    document.querySelectorAll('[data-countup], .hero-stats .hs b .trace, .big-number .trace, .region-facts b, .today-value b, .story-stat b')
      .forEach(element => observer.observe(element));
  }
  /* 等页面其他脚本把数字填好再开始观察。 */
  window.addEventListener('load', () => setTimeout(watch, 300));
})();
