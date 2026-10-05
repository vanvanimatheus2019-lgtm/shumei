/* 导览配音：浏览器语音合成（Web Speech API）；所选语音可能使用在线服务。
 *
 * 规则（与导览播放器配合）：
 *   · 自动播放时，每切换一章自动朗读这一章；读完才翻页。
 *   · 暂停（解除自动播放）后不再自动朗读；点播放器上的小喇叭可以手动读当前章，再点停止。
 *
 * “情绪”的做法：每章拆成短句，每句标一种语气。语气决定语速、音高、音量和句后停顿；
 * 数字句放慢，转折句前后多停一拍。浏览器语音合成只开放这几个参数，
 * 情绪靠它们的组合和停顿节奏表现，不是真人表演。
 */
(function () {
  const synth = window.speechSynthesis;
  const supported = !!(synth && window.SpeechSynthesisUtterance);

  /* 语气预设：rate 语速、pitch 音高、volume 音量、pause 句后停顿（毫秒） */
  const MOODS = {
    calm:       { label: '平静', rate: 0.96, pitch: 1.00, volume: 0.95, pause: 380 },
    wonder:     { label: '惊叹', rate: 0.90, pitch: 1.07, volume: 1.00, pause: 620 },
    warm:       { label: '温和', rate: 0.92, pitch: 1.02, volume: 0.95, pause: 450 },
    somber:     { label: '凝重', rate: 0.84, pitch: 0.90, volume: 0.88, pause: 760 },
    resolute:   { label: '坚定', rate: 0.88, pitch: 0.98, volume: 1.00, pause: 820 },
    reflective: { label: '沉思', rate: 0.88, pitch: 0.95, volume: 0.92, pause: 700 },
    rising:     { label: '上扬', rate: 0.98, pitch: 1.05, volume: 1.00, pause: 420 },
    proud:      { label: '自豪', rate: 0.90, pitch: 1.08, volume: 1.00, pause: 600 },
    closing:    { label: '收束', rate: 0.80, pitch: 1.00, volume: 1.00, pause: 1100 },
  };

  /* 每章的朗读稿。年份、百分数写成汉字，避免不同语音引擎读法不一。 */
  const SCRIPT = {
    start: [
      ['这是同一块地，隔了三十九年。', 'calm', { rate: 0.9 }],
      ['左边是一九八六年八月，能看到较多明亮裸地；', 'wonder'],
      ['右边是二零二五年八月，植被斑块和规则地块更多。', 'wonder', { pitch: 1.1 }],
      ['这里是陕西榆林横山区北部，毛乌素沙地的南缘。', 'calm'],
      ['这四十年里发生了什么？我们从一个人讲起。', 'warm'],
    ],
    people: [
      ['石光银，陕西定边人。一九八四年，他承包了三千多亩荒沙。', 'calm'],
      ['买树苗要钱，他把家里的八十四只羊和一头骡子，都卖了。', 'warm', { rate: 0.9 }],
      ['一九八六年春天，他带着一百多人进了狼窝沙。', 'calm'],
      ['那一年刮了十几场大风，栽下的树苗，九成被毁。', 'somber'],
      ['第二年又种，八成，又没了。', 'somber', { rate: 0.8, pause: 1000 }],
      ['他没有走。', 'resolute', { pause: 900 }],
    ],
    actions: [
      ['一九八八年，他换了办法。', 'resolute', { pause: 500 }],
      ['先在迎风坡上画格子、扎沙障，让沙丘不再跑；', 'calm'],
      ['沙障之间撒沙蒿、栽沙柳，把沙面连成片；低洼的地方，再种杨树和柳树。', 'calm'],
      ['十年后核查，这片地的植被覆盖率，到了百分之九十二点五。', 'proud'],
      ['种活了还不算完。死了的要补，林子要管，一干就是几十年。', 'warm'],
    ],
    process: [
      ['把镜头拉远，看整个研究范围。', 'calm'],
      ['这条线，是每年的植被指数。越高，表示植被绿度通常越高。', 'calm'],
      ['一九八六到二零零零年，区域均值在较低水平波动。', 'reflective'],
      ['区域均值不能直接判断某一块治理林地的成效。', 'reflective', { pause: 900 }],
      ['二零零一年起，曲线开始往上走。', 'rising'],
      ['二零一二年以后，整体处于较高水平，仍有年际起伏。', 'rising', { pitch: 1.08 }],
      ['地图展示不同地点的变化，不能只凭颜色判断原因。', 'wonder', { rate: 0.86 }],
    ],
    today: [
      ['比较一九八七到一九九一年，与二零二零到二零二四年的平均图。', 'calm'],
      ['共同有效的图像像元中，百分之六十九的植被指数上升超过零点一。', 'proud'],
      ['这是像元计数比例，未经地面面积加权；下降原因还没有完成归因。', 'calm'],
      ['基期低植被子集，两个五年窗口的覆盖度模型估算，从百分之七变化到约百分之四十一。', 'proud', { pitch: 1.1, pause: 800 }],
    ],
    method: [
      ['带虚线下划线的主要数字，可以点开查看来源、计算口径和限制。', 'calm'],
      ['树种活以后，还要一年一年补植和管护。', 'closing'],
    ],
  };

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('muus.voice.' + key); return v == null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem('muus.voice.' + key, value); } catch (e) { /* 隐私模式下忽略 */ } },
  };
  const settings = {
    voiceName: store.get('name', ''),
    speed: Math.min(1.25, Math.max(0.8, parseFloat(store.get('speed', '1')) || 1)),
  };

  let voices = [];
  let token = 0;
  let timer = null;
  let watchdog = null;
  let settleCurrent = null;
  let speaking = false;
  let current = null;           // 正在读的章节 id
  let line = null;              // 正在读的句子 { text, mood }
  const listeners = new Set();

  function score(voice) {
    const name = voice.name || '';
    const lang = (voice.lang || '').toLowerCase().replace('_', '-');
    let s = 0;
    if (lang.startsWith('zh-cn') || lang === 'zh' || lang.startsWith('cmn')) s += 20;
    else if (lang.startsWith('zh')) s += 8;
    else return -1;
    if (/xiaoxiao|晓晓/i.test(name)) s += 12;
    else if (/yunxi|云希|xiaoyi|晓伊|yunjian|云健/i.test(name)) s += 10;
    if (/natural|online|neural/i.test(name)) s += 6;
    if (/google/i.test(name)) s += 5;
    if (/huihui|yaoyao|kangkang|ting-?ting|li-mu|meijia/i.test(name)) s += 2;
    return s;
  }

  function chineseVoices() {
    return voices.filter(v => score(v) >= 0).sort((a, b) => score(b) - score(a));
  }

  function pickVoice() {
    const list = chineseVoices();
    return list.find(v => v.name === settings.voiceName) || list[0] || null;
  }

  function loadVoices() {
    if (!supported) return;
    voices = synth.getVoices() || [];
    emit();
  }

  function emit() { listeners.forEach(fn => { try { fn(state()); } catch (e) { /* 忽略 UI 回调错误 */ } }); }

  function state() {
    const voice = pickVoice();
    return { supported, available: supported && !!voice, speaking, chapter: current, line,
      voice: voice ? voice.name : null, voices: chineseVoices().map(v => v.name), speed: settings.speed };
  }

  /* 朗读时把背景音乐压低，读完恢复 */
  let duckedFrom = null;
  function duck(on) {
    const bgm = document.getElementById('bgm');
    if (!bgm) return;
    if (on && duckedFrom == null) { duckedFrom = bgm.volume; bgm.volume = Math.min(bgm.volume, 0.12); }
    if (!on && duckedFrom != null) { bgm.volume = duckedFrom; duckedFrom = null; }
  }

  function stop() {
    token++;
    clearTimeout(timer);
    clearTimeout(watchdog);
    timer = null;
    watchdog = null;
    const settle = settleCurrent;
    settleCurrent = null;
    if (settle) settle(false);
    if (supported) synth.cancel();
    const was = speaking;
    speaking = false;
    current = null;
    line = null;
    duck(false);
    if (was) emit();
  }

  /* 取消与异常都结束本次 Promise，防止旧朗读阻塞新章节。 */
  function speak(chapterId) {
    stop();
    const lines = SCRIPT[chapterId];
    const voice = pickVoice();
    if (!supported || !voice || !lines) return Promise.resolve(false);
    const my = ++token;
    speaking = true;
    current = chapterId;
    duck(true);
    emit();
    return new Promise(resolve => {
      let index = 0;
      let settled = false;
      const finish = completed => {
        if (settled) return;
        settled = true;
        if (settleCurrent === finish) settleCurrent = null;
        if (my === token) {
          clearTimeout(timer);
          clearTimeout(watchdog);
          speaking = false;
          current = null;
          line = null;
          duck(false);
          emit();
        }
        resolve(completed);
      };
      settleCurrent = finish;
      const next = () => {
        if (my !== token) return finish(false);
        if (index >= lines.length) return finish(true);
        const [text, moodName, extra] = lines[index++];
        const mood = Object.assign({}, MOODS[moodName] || MOODS.calm, extra || {});
        line = { text, mood: mood.label, index: index - 1, total: lines.length };
        emit();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice;
        utterance.lang = voice.lang || 'zh-CN';
        utterance.rate = Math.max(0.5, Math.min(2, mood.rate * settings.speed));
        utterance.pitch = Math.max(0, Math.min(2, mood.pitch));
        utterance.volume = Math.max(0, Math.min(1, mood.volume));
        let ended = false;
        utterance.onend = () => {
          if (ended || settled || my !== token) return;
          ended = true;
          clearTimeout(watchdog);
          timer = setTimeout(next, mood.pause / settings.speed);
        };
        utterance.onerror = () => {
          if (settled || my !== token) return;
          finish(false);
          synth.cancel();
        };
        /* 引擎未回调时退出朗读，不能把未听到的内容当作播放完成。 */
        watchdog = setTimeout(() => { finish(false); synth.cancel(); },
          text.length / (4.2 * utterance.rate) * 1000 + 6000);
        try { synth.speak(utterance); }
        catch (error) { finish(false); console.warn('语音引擎未能开始朗读', error); }
      };
      next();
    });
  }

  function setVoice(name) { settings.voiceName = name; store.set('name', name); emit(); }
  function setSpeed(value) {
    settings.speed = Math.min(1.25, Math.max(0.8, Number(value) || 1));
    store.set('speed', String(settings.speed));
    emit();
  }

  if (supported) {
    loadVoices();
    if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', loadVoices);
    else synth.onvoiceschanged = loadVoices;
    /* 离开页面时停止朗读 */
    window.addEventListener('pagehide', stop);
  }

  window.VOICE = {
    MOODS, SCRIPT, speak, stop, state, setVoice, setSpeed,
    isSpeaking: () => speaking,
    onChange: fn => { listeners.add(fn); fn(state()); return () => listeners.delete(fn); },
  };
})();
