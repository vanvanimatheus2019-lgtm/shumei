/* 首屏、故事与局部观测共用既有年份状态，不另造地图与图表状态。 */
(function () {
  const core = window.NARRATIVE_CORE;
  const chapters = core.CHAPTERS;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const player = { active: false, automatic: false, index: 0, elapsed: 0, startedAt: 0, timer: null, trigger: null, focusStep: 0, voiceChapter: null, voiceRun: 0 };
  const voice = window.VOICE || null;

  /* 每章的落点：[开始后多少毫秒, 要看的元素]。元素比可视区矮就居中，比可视区高就顶到导航栏下方。
   * 人物一章读到中段跟到时间线；四十年一章先看三段曲线，地图开始播放后跟到地图。 */
  const FOCUS = {
    start: [[0, '.hero-image', 'center']],
    people: [[0, '#story .sec-head', 'top'], [16000, '.main-story', 'top']],
    actions: [[0, '#beforeafter .sec-head', 'top']],
    process: [[0, '#phaseBlock', 'top'], [8000, '.map-card', 'center']],
    today: [[0, '.region-grid', 'center'], [16000, '.region-reading', 'center']],
    method: [[0, '#method .sec-head', 'top'], [7000, '.guard-row', 'center']],
  };
  let localCase = null;
  let heroCase = null;
  let imageKind = 'rgb';
  let heroKind = 'rgb';
  let localPair = [1986, 2025];
  let localROI = 'overview';
  const caseLoads = new Map();
  const caseRequests = new WeakMap();
  const LOCAL_PAIRS = [[1986, 2000], [2000, 2010], [2010, 2025], [1986, 2025]];
  /* 在原图上选的观察框，仅标形态，不是经过核验的土地分类。坐标为原图比例。 */
  const LOCAL_ROIS = [
    { id: 'town', name: '建设区轮廓', box: [.27, .39, .36, .31], note: '看道路和建设区的边界。城区扩展也会改变植被指数。' },
    { id: 'parcels', name: '规则地块', box: [.02, .34, .28, .27], note: '看规则地块的形状和颜色。这里含农田，绿色不能都算成治沙林。' },
    { id: 'patches', name: '非建设区斑块', box: [.65, .17, .28, .27], note: '看窗口东北部的植被斑块和裸露地表。仅凭四景影像不能区分降水、耕作和治理的影响。' },
  ];


  function setMode(mode, scroll) {
    const next = core.normalizeMode(mode);
    if (player.active) stopStory(false);
    document.body.dataset.view = next;
    $$('button[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === next)));
    const url = new URL(location.href);
    if (next === 'story') url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    history.replaceState(null, '', url);
    if (scroll !== false) {
      const target = next === 'method' ? '#method' : next === 'explore' ? '#stage' : '#hero';
      scrollToSection(target);
    }
    if (window.MU_APP) requestAnimationFrame(() => window.MU_APP.redraw());
  }

  function scrollToSection(selector) {
    const target = $(selector);
    if (!target) return;
    const top = target.getBoundingClientRect().top + scrollY - 75;
    window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }

  function focusElement(selector, align) {
    const target = $(selector);
    if (!target || !target.offsetParent) return;
    const nav = $('#nav');
    const top = nav ? nav.getBoundingClientRect().height : 64;
    const bar = $('#storyPlayer');
    const bottom = bar && !bar.hidden ? bar.getBoundingClientRect().height + 28 : 24;
    const zone = innerHeight - top - bottom;
    const rect = target.getBoundingClientRect();
    const offset = align !== 'top' && rect.height <= zone ? top + (zone - rect.height) / 2 : top + 14;
    window.scrollTo({ top: Math.max(0, rect.top + scrollY - offset), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }

  function applyFocus() {
    const steps = FOCUS[chapters[player.index].id] || [];
    while (player.focusStep < steps.length && player.elapsed >= steps[player.focusStep][0]) {
      focusElement(steps[player.focusStep][1], steps[player.focusStep][2]);
      player.focusStep++;
    }
  }

  /* 配音：只在自动播放时随章节切换朗读；手动喇叭读当前章 */
  function narrate(force) {
    if (!voice) return;
    if (!force && !player.automatic) return;
    const id = chapters[player.index].id;
    const run = ++player.voiceRun;
    player.voiceChapter = id;
    voice.speak(id).then(() => { if (player.voiceRun === run && player.voiceChapter === id) player.voiceChapter = null; });
  }

  function paintPlayer() {
    const chapter = chapters[player.index];
    $('#storyPlayer').hidden = !player.active;
    $('#storyChapterCount').textContent = (player.index + 1) + ' / ' + chapters.length;
    $('#storyChapterTitle').textContent = chapter.title;
    $('#storyChapterSubtitle').textContent = chapter.subtitle;
    $('#storyPause').textContent = player.automatic ? '暂停' : '继续';
    $('#storyPause').setAttribute('aria-pressed', String(player.automatic));
    $('#storyPrev').disabled = player.index === 0;
    $('#storyNext').textContent = player.index === chapters.length - 1 ? '结束' : '下一章';
    const percent = Math.min(100, player.elapsed / chapter.duration * 100);
    $('#storyProgress').style.width = percent + '%';
    $('.story-progress').setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  function applyStoryYear() {
    const chapter = chapters[player.index];
    const year = core.storyYearAt(chapter.id, player.elapsed);
    if (window.MU_APP && window.MU_APP.getState().year !== year) window.MU_APP.setYear(year, true, 'story');
    $$('[data-process-year]').forEach(frame => frame.classList.toggle('current', Number(frame.dataset.processYear) <= year));
    /* “今天”一章：先看前后对比，15 秒后切到变化图。 */
    if (chapter.id === 'today') applyRegionKind(player.elapsed > 15000 ? 'delta' : 'compare');
  }

  function tick() {
    if (!player.active || !player.automatic) return;
    player.elapsed = Math.min(chapters[player.index].duration, performance.now() - player.startedAt);
    applyStoryYear();
    applyFocus();
    paintPlayer();
    if (player.elapsed < chapters[player.index].duration) return;
    /* 时间到了但这一章还没读完：等读完再翻页 */
    if (voice && voice.isSpeaking() && player.voiceChapter === chapters[player.index].id) return;
    goChapter(player.index + 1, true);
  }

  function armStoryTimer() {
    clearInterval(player.timer);
    player.timer = null;
    if (!player.active || !player.automatic) return;
    player.startedAt = performance.now() - player.elapsed;
    player.timer = setInterval(tick, 120);
  }

  function goChapter(index, automatic) {
    if (index >= chapters.length) {
      stopStory(false);
      setMode('method', false);
      return;
    }
    player.index = Math.max(0, index);
    player.elapsed = 0;
    player.focusStep = 0;
    player.automatic = !!automatic;
    window.MU_APP.setPlaying(false);
    window.MU_APP.setComparison(false);
    window.MU_APP.setYear(chapters[player.index].year, true, 'story');
    paintPlayer();
    $('#storyPlayerStatus').textContent = chapters[player.index].title;
    applyFocus();
    if (voice) voice.stop();
    player.voiceChapter = null;
    narrate(false);
    armStoryTimer();
  }

  function startStory() {
    setMode('story', false);
    window.MU_APP.endTour();
    player.trigger = document.activeElement;
    player.active = true;
    document.body.classList.add('story-active');
    goChapter(0, true);
    $('#storyPause').focus({ preventScroll: true });
  }

  function pauseStory() {
    if (!player.active || !player.automatic) return;
    player.elapsed = Math.min(chapters[player.index].duration, performance.now() - player.startedAt);
    player.automatic = false;
    clearInterval(player.timer);
    player.timer = null;
    if (voice) voice.stop();
    player.voiceChapter = null;
    paintPlayer();
  }

  function toggleStory() {
    if (player.automatic) pauseStory();
    else {
      player.automatic = true;
      /* 恢复自动播放：这一章从头再读一遍，读完再翻页 */
      narrate(false);
      armStoryTimer();
      paintPlayer();
    }
  }

  function stopStory(restoreFocus) {
    clearInterval(player.timer);
    player.timer = null;
    player.active = false;
    player.automatic = false;
    if (voice) voice.stop();
    player.voiceChapter = null;
    document.body.classList.remove('story-active');
    $('#storyPlayer').hidden = true;
    if (window.MU_APP) window.MU_APP.setPlaying(false);
    if (restoreFocus !== false && player.trigger && player.trigger.focus) player.trigger.focus({ preventScroll: true });
  }

  const platformName = value => String(value || '').replace(/^landsat-(\d)$/i, 'Landsat $1');

  /* 第一次看到对比图时，分隔线自己扫一遍，告诉观众这里能拖。用户一碰就停。 */
  function sweepOnce(figure) {
    if (reducedMotion.matches || !('IntersectionObserver' in window)) return;
    let done = false, frame = 0;
    const stop = () => { done = true; cancelAnimationFrame(frame); };
    figure.addEventListener('pointerdown', stop, { once: true });
    figure.querySelector('[data-split]').addEventListener('input', stop, { once: true });
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || done) return;
      observer.disconnect();
      const keys = [[0, 96], [1400, 8], [2300, 50]];
      let start = 0;
      const step = now => {
        if (done) return;
        if (!start) start = now;
        const t = now - start;
        let value = 50;
        for (let i = 1; i < keys.length; i++) {
          if (t <= keys[i][0]) {
            const k = (t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
            const ease = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            value = keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * ease;
            break;
          }
        }
        setSplit(figure, value);
        if (t < keys[keys.length - 1][0]) frame = requestAnimationFrame(step);
      };
      setTimeout(() => { if (!done) frame = requestAnimationFrame(step); }, 500);
    }, { threshold: 0.6 });
    observer.observe(figure.querySelector('.compare-stage'));
  }

  function setSplit(figure, value) {
    const percent = core.clampSplit(Number(value));
    figure.querySelector('.compare-stage').style.setProperty('--split', percent + '%');
    figure.querySelector('[data-split]').value = percent;
    figure.querySelector('[data-split-output]').textContent = Math.round(percent) + '%';
  }

  function bindComparison(figure) {
    const stage = figure.querySelector('.compare-stage');
    const range = figure.querySelector('[data-split]');
    range.addEventListener('input', () => setSplit(figure, range.value));
    let dragging = false;
    const move = event => {
      const rect = stage.getBoundingClientRect();
      if (rect.width) setSplit(figure, (event.clientX - rect.left) / rect.width * 100);
    };
    stage.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = true;
      stage.setPointerCapture(event.pointerId);
      pauseStory();
      move(event);
    });
    stage.addEventListener('pointermove', event => { if (dragging) move(event); });
    stage.addEventListener('pointerup', () => { dragging = false; });
    stage.addEventListener('pointercancel', () => { dragging = false; });
    if (['hero', 'today'].includes(figure.dataset.comparison)) return;
    figure.querySelectorAll('img').forEach(image => image.addEventListener('error', () => {
      figure.querySelector('[data-compare-error]').hidden = false;
      figure.dataset.state = 'error';
    }));
  }

  function applyCaseImages() {
    if (localCase) buildLocalObservations();
    $$('[data-comparison="hero"],[data-comparison="today"]').forEach(figure => {
      const today = figure.dataset.comparison === 'today';
      const record = today ? localCase : heroCase;
      if (!record) return;
      const pair = today ? localPair : [1986, 2025];
      const scenes = pair.map(year => record.scenes.find(scene => scene.year === year));
      if (scenes.some(scene => !scene)) {
        setCaseState(figure, 'error', '处理记录缺少所选时点，请重试。');
        return;
      }
      paintCaseComparison(figure, scenes, today ? imageKind : heroKind);
    });
    $$('[data-image-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.imageKind === imageKind)));
    $$('[data-hero-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.heroKind === heroKind)));
    const heroLegend = $('#heroLegend'), localLegend = $('#localLegend');
    if (heroLegend) heroLegend.hidden = heroKind !== 'ndvi';
    if (localLegend) localLegend.hidden = imageKind !== 'ndvi';
    if (localCase) paintLocalObservations();
  }

  function setCaseState(figure, state, message) {
    figure.dataset.state = state;
    figure.setAttribute('aria-busy', String(state === 'loading'));
    const error = figure.querySelector('[data-compare-error]');
    error.hidden = state === 'ready';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    if (message) error.textContent = message;
    let retry = figure.querySelector('[data-case-retry]');
    if (!retry) {
      retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'case-image-retry'; retry.dataset.caseRetry = '';
      retry.textContent = '重新读取影像';
      retry.addEventListener('click', () => {
        const record = figure.dataset.comparison === 'today' ? localCase : heroCase;
        if (!record) { loadCaseRecords(); return; }
        record.scenes.forEach(scene => { caseLoads.delete(scene.rgb); caseLoads.delete(scene.ndvi); });
        applyCaseImages();
      });
      figure.append(retry);
    }
    retry.hidden = state !== 'error';
  }

  function loadCaseImage(src) {
    if (caseLoads.has(src)) return caseLoads.get(src);
    const loading = new Promise((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => failed(), 20000);
      const failed = () => {
        clearTimeout(timer); image.onload = null; image.onerror = null;
        if (caseLoads.get(src) === loading) caseLoads.delete(src);
        reject(new Error('影像未能读取，点击“重新读取影像”重试。'));
      };
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = failed;
      image.src = src;
    });
    caseLoads.set(src, loading);
    return loading;
  }

  function decodeCaseImage(image) {
    if (typeof image.decode === 'function') return image.decode();
    if (image.complete) return image.naturalWidth ? Promise.resolve() : Promise.reject(new Error('影像未能显示，请重新读取。'));
    return new Promise((resolve, reject) => {
      const finish = error => {
        image.removeEventListener('load', loaded); image.removeEventListener('error', failed);
        error ? reject(error) : resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error('影像未能显示，请重新读取。'));
      image.addEventListener('load', loaded, { once: true });
      image.addEventListener('error', failed, { once: true });
    });
  }

  function paintCaseComparison(figure, scenes, kind) {
    const today = figure.dataset.comparison === 'today';
    const request = (caseRequests.get(figure) || 0) + 1;
    caseRequests.set(figure, request);
    figure.dataset.pair = scenes.map(scene => scene.year).join('-');
    figure.dataset.kind = kind;
    setCaseState(figure, 'loading', '正在读取两期影像…');
    const place = today ? '盐池县城一带' : '横山区北部至巴拉素一带';
    figure.querySelector('[data-compare-caption]').textContent = scenes.map(scene => scene.date + ' · ' + platformName(scene.platform)).join(' ／ ')
      + '　同一 30 米网格，同一套显示参数。';
    Promise.all(scenes.map(scene => loadCaseImage(scene[kind]))).then(async () => {
      // 快速切年份或图层时，旧请求不能覆盖最后一次选择。
      if (caseRequests.get(figure) !== request) return;
      const images = scenes.map((scene, index) => {
        const image = figure.querySelector('[data-' + (index ? 'after' : 'before') + ']');
        image.src = scene[kind];
        return image;
      });
      // 预加载对象成功不等于页面中的 img 已解码；两期可显示后再解除遮罩。
      await Promise.all(images.map(decodeCaseImage));
      if (caseRequests.get(figure) !== request) return;
      scenes.forEach((scene, index) => {
        const side = index ? 'after' : 'before';
        const image = images[index];
        image.alt = scene.date + ' ' + place + '同地点' + (kind === 'rgb' ? '真彩色' : 'NDVI') + '影像';
        const label = figure.querySelector('[data-' + side + '-label]');
        label.textContent = today ? scene.date : String(scene.year);
        label.title = scene.date + ' · ' + platformName(scene.platform);
      });
      setCaseState(figure, 'ready');
    }).catch(error => {
      if (caseRequests.get(figure) === request) setCaseState(figure, 'error', error.message);
    });
  }

  function chooseLocalPair(pair, scroll) {
    pauseStory(); localPair = pair.slice(); applyCaseImages();
    if (scroll) scrollToSection('#today');
  }

  function buildLocalObservations() {
    const figure = $('[data-comparison="today"]');
    if (!figure || figure.dataset.observations) return;
    figure.dataset.observations = '1';
    const stage = figure.querySelector('.compare-stage');
    ['before', 'after'].forEach(side => {
      const image = stage.querySelector('[data-' + side + ']');
      const layer = document.createElement('div');
      layer.className = 'observation-layer observation-layer--' + side;
      image.before(layer); layer.append(image);
    });
    LOCAL_ROIS.forEach((roi, index) => {
      const frame = document.createElement('div');
      frame.className = 'observation-frame'; frame.dataset.roiFrame = roi.id;
      frame.style.cssText = 'left:' + roi.box[0] * 100 + '%;top:' + roi.box[1] * 100 + '%;width:' + roi.box[2] * 100 + '%;height:' + roi.box[3] * 100 + '%';
      frame.textContent = String(index + 1); frame.setAttribute('aria-hidden', 'true'); stage.append(frame);
    });
    const controls = figure.parentElement.querySelector('[data-local-controls]') || document.createElement('div');
    controls.className = 'local-observation-controls'; controls.dataset.localControls = '';
    controls.replaceChildren();
    const group = (title, buttons) => {
      const field = document.createElement('fieldset'), legend = document.createElement('legend');
      legend.textContent = title; field.append(legend, ...buttons); return field;
    };
    const button = (label, attribute, value, action) => {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
      node.dataset[attribute] = value; node.setAttribute('aria-pressed', 'false'); node.addEventListener('click', action); return node;
    };
    controls.append(group('看哪一段', LOCAL_PAIRS.map(pair => button(pair.join(' → '), 'localPair', pair.join('-'), () => chooseLocalPair(pair)))));
    controls.append(group('看哪里 · 两期同步放大', [{ id: 'overview', name: '看全图' }, ...LOCAL_ROIS].map((roi, index) =>
      button((index ? index + ' · ' : '') + roi.name, 'localRoi', roi.id, () => { pauseStory(); localROI = roi.id; paintLocalObservations(); }))));
    const note = document.createElement('p'); note.className = 'observation-note'; note.dataset.localObservation = ''; note.setAttribute('aria-live', 'polite');
    const reading = document.createElement('div'); reading.className = 'local-scene-reading'; reading.dataset.localReading = '';
    controls.append(note, reading); figure.after(controls);
  }

  function paintLocalObservations() {
    const figure = $('[data-comparison="today"]');
    if (!figure || !localCase || !figure.dataset.observations) return;
    const roi = LOCAL_ROIS.find(item => item.id === localROI), zoom = roi ? 2.2 : 1;
    const cx = roi ? roi.box[0] + roi.box[2] / 2 : .5, cy = roi ? roi.box[1] + roi.box[3] / 2 : .5;
    const centerX = Math.max(.5 / zoom, Math.min(1 - .5 / zoom, cx)), centerY = Math.max(.5 / zoom, Math.min(1 - .5 / zoom, cy));
    figure.querySelector('.compare-stage').style.setProperty('--observation-transform', 'translate(' + (50 - centerX * zoom * 100) + '%,' + (50 - centerY * zoom * 100) + '%) scale(' + zoom + ')');
    figure.dataset.roi = localROI;
    $$('[data-local-pair]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.localPair === localPair.join('-'))));
    $$('[data-local-roi]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.localRoi === localROI)));
    $$('[data-roi-frame]').forEach(frame => { frame.hidden = !!roi; });
    $('[data-local-observation]').textContent = roi ? roi.note + ' 两期均放大 2.2 倍，保留原图像元。' : '框 1 看建设区，框 2 看规则地块，框 3 看非建设区斑块。四景是各年的单日观测，2000 年的窗口均值低于 1986 年，并非逐年变绿。';
    $('[data-local-reading]').replaceChildren(...localPair.map((year, index) => {
      const scene = localCase.scenes.find(item => item.year === year), card = document.createElement('p');
      const date = document.createElement('b'); date.textContent = (index ? '右 ' : '左 ') + scene.date + ' · ' + platformName(scene.platform);
      const value = document.createElement('span'); value.textContent = '整窗口单景 NDVI 均值 ' + scene.meanNDVIWithinValidWindow.toFixed(3);
      const product = document.createElement('span'); product.className = 'local-product-id'; product.textContent = scene.itemId;
      const valid = document.createElement('span'); valid.textContent = '窗口有效像元 ' + (scene.validFraction * 100).toFixed(1) + '% · 30 米';
      card.append(date, value, product, valid); return card;
    }));
    $$('[data-process-year]').forEach(frame => {
      frame.classList.toggle('is-selected', localPair.includes(Number(frame.dataset.processYear)));
      const button = frame.querySelector('button');
      if (button) button.setAttribute('aria-pressed', String(localPair.includes(Number(frame.dataset.processYear))));
    });
  }

  function buildPersonStory() {
    const person = window.DATA.MAIN_STORY;
    if (!person) return;
    $('#mainPersonName').textContent = person.name;
    $('#mainPersonPlace').textContent = person.place;
    $('#mainPersonIntro').textContent = person.intro;
    if (person.photo) {
      const figure = document.createElement('figure');
      figure.className = 'person-photo';
      const image = document.createElement('img');
      image.src = person.photo; image.alt = person.photoCaption; image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      const caption = document.createElement('figcaption');
      const credit = document.createElement('a');
      credit.href = person.photoSource; credit.target = '_blank'; credit.rel = 'noopener';
      credit.textContent = person.photoCredit;
      caption.append(document.createTextNode(person.photoCaption + ' · '), credit);
      figure.append(image, caption);
      image.addEventListener('error', () => {
        if (person.photoRemote && !image.dataset.triedRemote) { image.dataset.triedRemote = '1'; image.src = person.photoRemote; return; }
        figure.remove();
        document.querySelector('.person-initial').hidden = false;
      });
      image.addEventListener('load', () => { document.querySelector('.person-initial').hidden = true; });
      $('.story-intro').prepend(figure);
    }
    const timeline = $('#mainPersonTimeline');
    person.chapters.forEach(chapter => {
      const article = document.createElement('article');
      article.className = 'person-moment';
      const time = document.createElement('time');
      time.textContent = String(chapter.year);
      const title = document.createElement('h4');
      title.textContent = chapter.title;
      const text = document.createElement('p');
      text.textContent = chapter.text;
      const link = document.createElement('a');
      link.href = chapter.source;
      link.textContent = '资料出处 ↗';
      link.target = '_blank'; link.rel = 'noopener';
      article.append(time, title, text, link);
      timeline.append(article);
    });
  }

  function buildLocalProcess() {
    const container = $('#localProcess');
    if (!container || !localCase || !localCase.available) return;
    container.replaceChildren();
    localCase.scenes.forEach(scene => {
      const figure = document.createElement('figure');
      figure.dataset.processYear = scene.year;
      const select = document.createElement('button'); select.type = 'button';
      select.className = 'local-scene-select'; select.setAttribute('aria-pressed', 'false');
      const pair = LOCAL_PAIRS.find(item => item[1] === scene.year) || [1986, 2025];
      select.setAttribute('aria-label', '比较 ' + pair[0] + ' 与 ' + pair[1] + ' 年的同地点影像');
      select.addEventListener('click', () => chooseLocalPair(pair, true));
      const image = document.createElement('img');
      image.src = scene.rgb; image.decoding = 'async'; image.alt = scene.date + ' 盐池县城一带真彩色影像';
      const caption = document.createElement('figcaption');
      const date = document.createElement('b'); date.textContent = scene.date;
      const note = document.createElement('span'); note.textContent = platformName(scene.platform) + ' · 窗口平均 NDVI ' + scene.meanNDVIWithinValidWindow.toFixed(3);
      caption.append(date, note); select.append(image); figure.append(select, caption); container.append(figure);
    });
    paintLocalObservations();
  }

  function buildCaseSources() {
    const box = $('#caseSources');
    if (!localCase && !heroCase) { box.textContent = '局部影像处理记录暂未读取，请重试。'; return; }
    const heading = text => { const h = document.createElement('p'); h.className = 'case-src-head'; h.textContent = text; return h; };
    const nodes = [];
    if (heroCase && heroCase.available) {
      nodes.push(heading('首屏 · 横山区北部至巴拉素一带（109.24°—109.42°E，38.03°—38.21°N）'));
      const heroList = document.createElement('ul');
      heroCase.scenes.forEach(scene => {
        const row = document.createElement('li');
        const link = document.createElement('a'); link.href = scene.sourceUrl;
        link.target = '_blank'; link.rel = 'noopener'; link.textContent = scene.date + ' · ' + scene.itemId;
        row.append(link, document.createTextNode(' · ' + platformName(scene.platform) + ' · 整景云量 ' + scene.cloudCoverScenePercent + '% · 窗口平均 NDVI ' + scene.meanNDVIWithinValidWindow.toFixed(3)));
        heroList.append(row);
      });
      const why = document.createElement('p');
      why.textContent = '这个窗口按早期植被指数较低、后期上升明显来挑选，属于变化突出的典型窗口。画面仍含农田与道路；低植被指数不能证明原地类全是沙地，也不能用这个窗口代表整片毛乌素。来源记录附有单景统计，尚不能据此完成治理归因。';
      nodes.push(heroList, why, heading('“今天”一节 · 宁夏盐池县城一带（107.32°—107.50°E，37.70°—37.88°N）'));
    }
    const list = document.createElement('ul');
    (localCase ? localCase.scenes : []).forEach(scene => {
      const row = document.createElement('li');
      const link = document.createElement('a'); link.href = scene.sourceUrl;
      link.target = '_blank'; link.rel = 'noopener'; link.textContent = scene.date + ' · ' + scene.itemId;
      row.append(link, document.createTextNode(' · ' + platformName(scene.platform) + ' · 有效像元 ' + (scene.validFraction * 100).toFixed(1) + '%'));
      list.append(row);
    });
    box.replaceChildren(...nodes, list);
    const note = document.createElement('p');
    note.textContent = '盐池四景重投影到同一 30 米网格（最近邻）；真彩色统一用反射率 0—0.35、gamma 1.3 显示，没有对某一年单独调色。观测日期、产品编号、有效像元比例和处理参数见随站保存的 manifest；原始窗口与处理脚本需以完整工程包为准。';
    box.append(note);
  }

  function fillToday() {
    const headline = window.DATA.HEADLINE;
    $('#todayNdviLo').textContent = window.DATA.fmtNum(headline.ndvi[0], 3);
    $('#todayNdviHi').textContent = window.DATA.fmtNum(headline.ndvi[1], 3);
    $('#todayCoverLo').textContent = window.DATA.fmtNum(headline.fvcCore[0], 1) + '%';
    $('#todayCoverHi').textContent = window.DATA.fmtNum(headline.fvcCore[1], 1) + '%';
  }


  /* ---------- 整片研究区：五年平均对比与变化图 ---------- */
  const REGION_IMAGES = {
    before: 'assets/data/change/window-1987-1991.png',
    after: 'assets/data/change/window-2020-2024.png',
    delta: 'assets/data/change/delta-ndvi.png',
  };
  let regionKind = 'compare';

  function placeRegionLabels() {
    const figure = $('[data-comparison="region"]');
    if (!figure) return;
    const stage = figure.querySelector('.compare-stage');
    const box = window.DATA.GEO.bbox;
    const layer = document.createElement('div');
    layer.className = 'region-labels';
    layer.setAttribute('aria-hidden', 'true');
    window.DATA.GEO.places.forEach(place => {
      const x = (place.lon - box.lonMin) / (box.lonMax - box.lonMin) * 100;
      const y = (box.latMax - place.lat) / (box.latMax - box.latMin) * 100;
      if (x < 2 || x > 98 || y < 2 || y > 98) return;
      const label = document.createElement('span');
      label.style.left = x + '%'; label.style.top = y + '%';
      label.textContent = place.name;
      layer.append(label);
    });
    stage.append(layer);
    const old = $('#regionPlaces');
    if (old) old.remove();
  }

  function applyRegionKind(kind) {
    const figure = $('[data-comparison="region"]');
    if (!figure) return;
    regionKind = kind === 'delta' ? 'delta' : 'compare';
    const delta = regionKind === 'delta';
    figure.querySelector('[data-before]').src = delta ? REGION_IMAGES.delta : REGION_IMAGES.before;
    figure.querySelector('[data-after]').src = delta ? REGION_IMAGES.delta : REGION_IMAGES.after;
    figure.querySelector('[data-before]').alt = delta ? '1987—1991 到 2020—2024 的 NDVI 变化图' : '1987至1991年五年平均NDVI图';
    figure.classList.toggle('is-delta', delta);
    figure.querySelector('[data-compare-title]').textContent = delta ? '整片研究区 · NDVI 变化量' : '整片研究区 · 五年平均 NDVI';
    figure.querySelector('[data-compare-caption]').textContent = delta
      ? '2020—2024 平均减去 1987—1991 平均。绿色越深，上升越多；红色为下降。'
      : '左：1987—1991 平均　右：2020—2024 平均　色标与上方地图相同（0—0.7）。';
    $('#deltaLegend').hidden = !delta;
    $$('[data-region-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.regionKind === regionKind)));
  }

  function fillChange() {
    const change = window.DATA.CHANGE;
    if (!change) return;
    const pct = (value, digits) => (value * 100).toFixed(digits) + '%';
    $('#changeShare').textContent = pct(change.shareRise010, 0);
    $('#changeShare005').textContent = pct(change.shareRise005, 0);
    $('#changeFall').textContent = pct(change.shareFall010, 2);
    const headline = window.DATA.HEADLINE;
    $('#changeMeans').textContent = window.DATA.fmtNum(headline.ndvi[0], 3) + ' → ' + window.DATA.fmtNum(headline.ndvi[1], 3);
  }

  /* ---------- 三段曲线：回答“中间发生了什么” ---------- */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    if (text != null) node.textContent = text;
    return node;
  }

  let phaseCursor = null;
  function buildPhaseChart() {
    const host = $('#phaseChart');
    const data = window.DATA;
    if (!host || !data.PHASES) return;
    const values = data.MU_SERIES.ndvi;
    /* 视窗宽度决定坐标系：1 个单位 = 1 个 CSS 像素，手机上字不会被缩小。 */
    const narrow = host.clientWidth < 600;
    const W = Math.max(320, Math.round(host.clientWidth - 16) || 900), H = narrow ? 268 : 286;
    const L = narrow ? 38 : 46, R = narrow ? 8 : 14, T = 18, B = narrow ? 88 : 94;
    const yMin = 0.14, yMax = 0.37;
    const x = year => L + (year - 1986) / 39 * (W - L - R);
    const y = value => T + (yMax - value) / (yMax - yMin) * (H - T - B);
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'phase-svg' });
    const tones = ['rgba(217,180,124,.13)', 'rgba(170,205,140,.10)', 'rgba(111,211,149,.15)'];
    data.PHASES.forEach((phase, index) => {
      const x0 = x(phase.start - 0.5 < 1986 ? 1986 : phase.start - 0.5);
      const x1 = x(phase.end + 0.5 > 2025 ? 2025 : phase.end + 0.5);
      svg.append(svgEl('rect', { x: x0, y: T, width: x1 - x0, height: H - T - B, fill: tones[index] }));
      svg.append(svgEl('text', { x: x0 + 6, y: T + 16, class: 'phase-band-label' }, narrow ? String(phase.start) : phase.start + '—' + phase.end + ' · ' + phase.name));
    });
    [0.15, 0.2, 0.25, 0.3, 0.35].forEach(tick => {
      svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(tick), y2: y(tick), class: 'phase-grid' }));
      svg.append(svgEl('text', { x: L - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'phase-axis' }, tick.toFixed(2)));
    });
    (narrow ? [1986, 2000, 2012, 2025] : [1986, 1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]).forEach(year => {
      svg.append(svgEl('text', { x: x(year), y: H - B + 18, 'text-anchor': year === 2025 ? 'end' : year === 1986 ? 'start' : 'middle', class: 'phase-axis' }, String(year)));
    });
    const path = values.map((value, index) => (index ? 'L' : 'M') + x(1986 + index).toFixed(1) + ' ' + y(value).toFixed(1)).join(' ');
    svg.append(svgEl('path', { d: path, class: 'phase-line' }));
    values.forEach((value, index) => svg.append(svgEl('circle', { cx: x(1986 + index), cy: y(value), r: 2.6, class: 'phase-dot' })));
    const events = data.MILESTONES.filter(item => item.source && item.year >= 1986 && item.year <= 2025);
    const labels = narrow
      ? { 1986: '树苗被毁', 1988: '改设沙障', 1999: '退耕还林', 2002: '防沙治沙法', 2008: '宁夏示范区', 2021: '七一勋章' }
      : { 1986: '狼窝沙树苗被毁', 1988: '改设沙障', 1999: '退耕还林试点', 2002: '《防沙治沙法》施行', 2008: '宁夏防沙治沙示范区', 2021: '石光银获七一勋章' };
    /* 事件标签按宽度贪心分行，避免手机上互相压住。 */
    const rows = [];
    /* 从右往左排：左边事件的竖线不会穿过右边事件的文字 */
    events.slice().reverse().forEach(item => {
      const ex = x(item.year);
      const text = item.year + ' ' + (labels[item.year] || item.title.replace(/：.*/, ''));
      const width = [...text].reduce((sum, ch) => sum + (/[\x00-\xff]/.test(ch) ? 0.6 : 1), 0) * (narrow ? 11 : 13) + 6;
      const anchor = ex + width > W - R ? 'end' : 'start';
      const left = anchor === 'end' ? ex - width : ex, right = anchor === 'end' ? ex : ex + width;
      /* 选一行：这一行放得下，且上面各行的文字不压在本事件的竖线位置上 */
      let row = 0;
      const blocked = r => (rows[r] && rows[r].some(span => span[0] < right + 6 && span[1] > left - 6))
        || rows.slice(0, r).some(spans => spans && spans.some(span => span[0] - 2 < ex && span[1] + 2 > ex));
      while (row < 6 && blocked(row)) row++;
      if (!rows[row]) rows[row] = [];
      rows[row].push([left, right]);
      svg.append(svgEl('line', { x1: ex, x2: ex, y1: H - B + 26, y2: H - B + 32 + row * 16, class: 'phase-event-tick' }));
      svg.append(svgEl('text', { x: anchor === 'end' ? ex + 2 : ex - 2, y: H - B + 44 + row * 16, 'text-anchor': anchor, class: 'phase-event' }, text));
    });
    const extraRows = Math.max(0, rows.length - 3);
    if (extraRows) svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + extraRows * 16));
    const cursor = svgEl('g', { class: 'phase-cursor' });
    cursor.append(svgEl('line', { x1: 0, x2: 0, y1: T, y2: H - B }));
    cursor.append(svgEl('circle', { cx: 0, cy: 0, r: 6 }));
    const cursorLabel = svgEl('text', { x: 0, y: 0, class: 'phase-cursor-label' }, '');
    cursor.append(cursorLabel);
    svg.append(cursor);
    const hit = svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B + 10, fill: 'transparent', class: 'phase-hit' });
    svg.append(hit);
    host.replaceChildren(svg);

    const moveCursor = year => {
      const value = values[year - 1986];
      cursor.setAttribute('transform', 'translate(' + x(year).toFixed(1) + ' 0)');
      cursor.querySelector('circle').setAttribute('cy', y(value).toFixed(1));
      cursorLabel.setAttribute('y', (y(value) - 12).toFixed(1));
      const flip = x(year) > W * 0.72;
      cursorLabel.setAttribute('text-anchor', flip ? 'end' : 'start');
      cursorLabel.setAttribute('x', flip ? -10 : 10);
      cursorLabel.textContent = year + ' · ' + value.toFixed(3);
      $$('#phaseList li').forEach((item, index) => {
        const phase = data.PHASES[index];
        item.classList.toggle('current', year >= phase.start && year <= phase.end);
      });
    };
    const yearFromEvent = event => {
      const rect = svg.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width * W;
      return Math.max(1986, Math.min(2025, Math.round(1986 + (px - L) / (W - L - R) * 39)));
    };
    let dragging = false;
    hit.addEventListener('pointerdown', event => { dragging = true; hit.setPointerCapture(event.pointerId); pauseStory(); window.MU_APP.setPlaying(false); window.MU_APP.setYear(yearFromEvent(event)); });
    hit.addEventListener('pointermove', event => { if (dragging) window.MU_APP.setYear(yearFromEvent(event)); });
    hit.addEventListener('pointerup', () => { dragging = false; });
    hit.addEventListener('pointercancel', () => { dragging = false; });
    host.tabIndex = 0;
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', '年度 NDVI 曲线；左右箭头换年份，Home 和 End 跳到首尾');
    if (!host.dataset.built) host.addEventListener('keydown', event => {
      const year = window.MU_APP.getState().year;
      if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        pauseStory(); window.MU_APP.setPlaying(false);
        window.MU_APP.setYear(event.key === 'Home' ? 1986 : event.key === 'End' ? 2025 : year + (event.key === 'ArrowRight' ? 1 : -1));
      }
    });
    phaseCursor = moveCursor;
    moveCursor(window.MU_APP ? window.MU_APP.getState().year : 1986);
    if (host.dataset.built) return;
    host.dataset.built = '1';
    window.addEventListener('mu:year', event => phaseCursor && phaseCursor(event.detail.year));
    let lastWidth = host.clientWidth, timer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (Math.abs(host.clientWidth - lastWidth) > 40) { lastWidth = host.clientWidth; buildPhaseChart(); } }, 200);
    });

    const list = $('#phaseList');
    const seg = (start, end) => values.slice(start - 1986, end - 1986 + 1);
    const texts = data.PHASES.map((phase, index) => {
      const part = seg(phase.start, phase.end);
      const lo = Math.min(...part).toFixed(3), hi = Math.max(...part).toFixed(3);
      if (index === 0) return ['波动中大致平稳', '区域 NDVI 在 ' + lo + '—' + hi + ' 之间波动，拟合斜率为每年 ' + phase.slope.toFixed(4) + '。这段区域曲线不能判断定边某块治理林地的变化。'];
      if (index === 1) return ['均值开始上升', '拟合斜率为每年 +' + phase.slope.toFixed(4) + '，从 ' + part[0].toFixed(3) + ' 到 ' + part[part.length - 1].toFixed(3) + '。下方人物经历和政策是同期背景，不能据时间相邻证明上升原因。'];
      const after = values.slice(phase.start + 1 - 1986);
      return ['高位仍有年际波动', (phase.start + 1) + ' 年以后，最低一年为 ' + Math.min(...after).toFixed(3) + '；拟合斜率为每年 +' + phase.slope.toFixed(4) + '，2025 年为 ' + part[part.length - 1].toFixed(3) + '。这些数描述区域均值，不能换算为治沙面积。'];
    });
    list.replaceChildren(...data.PHASES.map((phase, index) => {
      const item = document.createElement('li');
      const head = document.createElement('button');
      head.type = 'button';
      head.innerHTML = '<span>' + phase.start + '—' + phase.end + '</span><b>' + texts[index][0] + '</b>';
      head.addEventListener('click', () => { pauseStory(); window.MU_APP.setPlaying(false); window.MU_APP.setYear(phase.end); });
      const body = document.createElement('p');
      body.textContent = texts[index][1];
      item.append(head, body);
      return item;
    }));
  }

  /* ---------- 地图上的播放提示：停在 1986 时给一个明确的入口 ---------- */
  function buildMapPlayCue() {
    const wrap = $('.map-wrap');
    if (!wrap) return;
    const cue = document.createElement('button');
    cue.type = 'button';
    cue.className = 'map-play-cue';
    cue.innerHTML = '<span aria-hidden="true">▶</span> 播放 1986 → 2025';
    cue.addEventListener('click', () => {
      pauseStory();
      cue.hidden = true;
      if (window.MU_APP.getState().year >= 2025) window.MU_APP.setYear(1986);
      window.MU_APP.setPlaying(true);
    });
    wrap.append(cue);
    window.addEventListener('mu:year', event => { cue.hidden = event.detail.year !== 1986 || window.MU_APP.getState().playing; });
  }

  function bindNavigation() {
    $$('button[data-view]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.view)));
    $$('[data-action]').forEach(control => control.addEventListener('click', event => {
      event.preventDefault();
      setMode(control.dataset.action);
      const target = control.getAttribute('href');
      if (target && target.startsWith('#')) scrollToSection(target);
    }));
    $('#storyPause').addEventListener('click', toggleStory);
    $('#storyClose').addEventListener('click', () => stopStory());
    /* 上一章/下一章保留当前的播放状态：自动播放中就继续自动并朗读，暂停中就保持安静 */
    $('#storyNext').addEventListener('click', () => goChapter(player.index + 1, player.automatic));
    $('#storyPrev').addEventListener('click', () => goChapter(player.index - 1, player.automatic));
    bindVoiceControls();
    $('#showEstimates').addEventListener('change', event => { document.body.dataset.estimates = event.target.checked ? 'show' : 'hide'; window.MU_APP.redraw(); });
    $('#mapRetry').addEventListener('click', () => { window.RENDER.retryRealImage(window.MU_APP.getState().year); window.MU_APP.redraw(); });
    $$('[data-image-kind]').forEach(button => button.addEventListener('click', () => { imageKind = button.dataset.imageKind; applyCaseImages(); }));
    $$('[data-hero-kind]').forEach(button => button.addEventListener('click', () => { heroKind = button.dataset.heroKind; applyCaseImages(); }));
    $$('[data-region-kind]').forEach(button => button.addEventListener('click', () => applyRegionKind(button.dataset.regionKind)));
    $$('.nav-links a,.nav-brand').forEach(link => link.addEventListener('click', event => {
      if (link.dataset.action) return;
      event.preventDefault();
      if (document.body.dataset.view === 'method') setMode('story', false);
      stopStory(false); scrollToSection(link.getAttribute('href'));
    }));
    const manualTargets = '#tlRange,#panelPlay,#tlPlay,.chart-box,.map-wrap,.ab-bar,#mapLayers,[data-comparison],#phaseBlock,[data-region-kind]';
    document.addEventListener('pointerdown', event => { if (event.target.closest(manualTargets)) pauseStory(); }, true);
    document.addEventListener('input', event => { if (event.target.closest(manualTargets)) pauseStory(); }, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) pauseStory(); });
    window.addEventListener('mu:year', event => {
      if (player.active && event.detail && event.detail.origin !== 'story') pauseStory();
    });
    $$('.trace[data-trace]').forEach(control => {
      if (control.tagName === 'BUTTON') return;
      control.tabIndex = 0;
      control.setAttribute('role', 'button');
      control.setAttribute('aria-haspopup', 'dialog');
      control.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); control.click(); }
      });
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#traceModal').hidden) {
        event.preventDefault(); window.MU_APP.closeTrace(); return;
      }
      if (!player.active || event.target.closest('input,textarea,select,.chart-box,[contenteditable]')) return;
      if (event.key === 'Escape') { event.preventDefault(); stopStory(); }
      else if (!event.target.closest('button,a') && event.key === 'ArrowRight') { event.preventDefault(); goChapter(player.index + 1, false); }
      else if (!event.target.closest('button,a') && event.key === 'ArrowLeft') { event.preventDefault(); goChapter(player.index - 1, false); }
      else if (!event.target.closest('button,a') && event.code === 'Space') { event.preventDefault(); toggleStory(); }
    });
  }

  async function loadCaseRecords() {
    const records = [
      { type: 'hero', path: 'assets/data/hero-case/manifest.json' },
      { type: 'today', path: 'assets/data/local-case/manifest.json' },
    ];
    await Promise.all(records.map(async record => {
      const figure = $('[data-comparison="' + record.type + '"]');
      if (!figure) return;
      setCaseState(figure, 'loading', '正在读取影像处理记录…');
      try {
        const response = await fetch(record.path);
        if (!response.ok) throw new Error('影像处理记录未能读取，请重试。');
        const result = await response.json();
        if (!result.available || !Array.isArray(result.scenes)) throw new Error('影像处理记录不完整，请重试。');
        if (record.type === 'hero') heroCase = result;
        else { localCase = result; buildLocalObservations(); buildLocalProcess(); }
        applyCaseImages(); buildCaseSources();
      } catch (error) {
        setCaseState(figure, 'error', error.message);
        figure.querySelector('[data-compare-caption]').textContent = '这个窗口的处理记录暂未读到。另一窗口可独立查看。';
      }
    }));
  }

  async function init() {
    buildPersonStory(); fillToday(); fillChange(); bindNavigation();
    placeRegionLabels(); buildPhaseChart(); buildMapPlayCue();
    $$('[data-comparison]').forEach(bindComparison);
    $$('[data-comparison="hero"],[data-comparison="region"]').forEach(sweepOnce);
    const params = new URLSearchParams(location.search);
    const methodAnchor = ['#method', '#about'].includes(location.hash);
    setMode(params.get('view') || (methodAnchor ? 'method' : 'story'), false);
    if (methodAnchor) requestAnimationFrame(() => scrollToSection(location.hash));
    if (params.has('tour')) startStory();
    await loadCaseRecords();
  }

  function bindVoiceControls() {
    const button = $('#storyVoice'), menu = $('#storyVoiceMenu'), panel = $('#storyVoicePanel');
    const select = $('#storyVoiceSelect'), speed = $('#storyVoiceSpeed'), speedOut = $('#storyVoiceSpeedOut');
    const moodTag = $('#storyMood'), note = $('#storyVoiceNote');
    if (!button) return;
    if (!voice) { button.disabled = true; button.title = '这个浏览器不支持语音合成'; return; }
    button.addEventListener('click', () => {
      if (voice.isSpeaking()) { voice.stop(); player.voiceChapter = null; return; }
      narrate(true);
    });
    menu.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      menu.setAttribute('aria-expanded', String(!panel.hidden));
    });
    select.addEventListener('change', () => voice.setVoice(select.value));
    speed.addEventListener('input', () => voice.setSpeed(speed.value));
    let listed = '';
    voice.onChange(state => {
      button.setAttribute('aria-pressed', String(state.speaking));
      button.classList.toggle('speaking', state.speaking);
      button.disabled = !state.available;
      button.title = !state.supported ? '这个浏览器不支持语音合成'
        : !state.available ? '没有找到中文语音：建议用 Edge 或 Chrome 打开'
        : state.speaking ? '停止朗读' : '朗读这一章';
      if (moodTag) {
        moodTag.hidden = !(state.speaking && state.line);
        if (state.line) moodTag.textContent = '语气 · ' + state.line.mood;
      }
      const key = state.voices.join('|');
      if (key !== listed) {
        listed = key;
        select.replaceChildren(...state.voices.map(name => { const o = document.createElement('option'); o.value = name; o.textContent = name.replace(/^Microsoft\s+/, '').replace(/\s*-\s*Chinese.*$/, ''); return o; }));
      }
      if (state.voice) select.value = state.voice;
      speed.value = state.speed;
      speedOut.textContent = state.speed.toFixed(2) + '×';
      if (note && state.supported && !state.available) note.textContent = '当前浏览器没有可用中文语音，可继续阅读，或观看页面底部的合成配音演示。';
    });
  }

  window.NARRATIVE = { start: startStory, pause: pauseStory, stop: stopStory, setMode,
    isActive: () => player.active,
    getState: () => ({ active: player.active, automatic: player.automatic, chapter: player.index, elapsed: player.elapsed, mode: document.body.dataset.view }),
    goChapter: index => { if (!player.active) startStory(); goChapter(index, false); },
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
