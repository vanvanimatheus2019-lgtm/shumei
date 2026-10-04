/* 故事的时间与年份规则独立于DOM，便于核对播放和手动操作的边界。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NARRATIVE_CORE = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CHAPTERS = Object.freeze([
    { id: 'start', section: '#hero', title: '同一块地，隔了三十九年', subtitle: '拖动中间的线，左边 1986，右边 2025。', duration: 25000, year: 1986 },
    { id: 'people', section: '#story', title: '卖了羊和骡子，换来第一批树苗', subtitle: '石光银在狼窝沙的头几年。', duration: 35000, year: 1986 },
    { id: 'actions', section: '#beforeafter', title: '先稳住沙，再让植物扎根', subtitle: '1988 年换的办法：沙障、灌草、低地种树。', duration: 30000, year: 1986 },
    { id: 'process', section: '#stage', title: '四十年，分三段看', subtitle: '先平十五年，2001 年后一路往上。', duration: 45000, year: 1986 },
    { id: 'today', section: '#today', title: '现在的样子', subtitle: '整片研究区变绿了多少，城镇在哪里扩张。', duration: 30000, year: 2025 },
    { id: 'method', section: '#method', title: '这些数从哪里来', subtitle: '每个数字都能点开，看输入、算法和限制。', duration: 15000, year: 2025 },
  ]);
  /* 在三段变化的分界处停下来：2000（平稳期末）、2011（上升期末）、2025。 */
  const PROCESS_STOPS = [
    [0, 1986], [8000, 2000], [14000, 2000], [24000, 2011],
    [30000, 2011], [40000, 2025], [45000, 2025],
  ];

  function requireFinite(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('需要有限数字');
    return value;
  }

  function clampYear(year) {
    return Math.max(1986, Math.min(2025, Math.round(requireFinite(year))));
  }

  function clampSplit(percent) {
    return Math.max(0, Math.min(100, requireFinite(percent)));
  }

  function normalizeMode(mode) {
    return ['story', 'explore', 'method'].includes(mode) ? mode : 'story';
  }

  function storyYearAt(chapterId, elapsed) {
    const chapter = CHAPTERS.find(entry => entry.id === chapterId);
    if (!chapter) throw new RangeError('未知故事章节');
    const time = Math.max(0, Math.min(chapter.duration, requireFinite(elapsed)));
    if (chapterId !== 'process') return chapter.year;
    for (let index = 1; index < PROCESS_STOPS.length; index++) {
      const [end, endYear] = PROCESS_STOPS[index];
      if (time > end) continue;
      const [start, startYear] = PROCESS_STOPS[index - 1];
      return clampYear(startYear + (endYear - startYear) * (time - start) / (end - start));
    }
    return 2025;
  }

  return Object.freeze({ CHAPTERS, clampYear, clampSplit, normalizeMode, storyYearAt });
});
