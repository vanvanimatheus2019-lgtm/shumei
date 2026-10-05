/* 40幅原年度产品依次播放；年际淡变只用于显示。 */
(function () {
  const FPS=25, FRAMES_PER_YEAR=7, YEARS=40;
  const section=document.querySelector('#opening');
  if(!section)return;
  const video=document.querySelector('#openingVideo');
  const yearEl=document.querySelector('#openingYear'),ndviEl=document.querySelector('#openingNdvi'),phaseEl=document.querySelector('#openingPhase'),bar=document.querySelector('#openingBar');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const status=document.createElement('p');status.className='opening-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');section.appendChild(status);
  const pauseButton=document.createElement('button');pauseButton.type='button';pauseButton.className='opening-pause';pauseButton.textContent='暂停';pauseButton.setAttribute('aria-label','暂停开场短片');
  section.querySelector('.opening-top').insertBefore(pauseButton,document.querySelector('#openingSkip'));
  let lastIndex=-1,raf=0,still=null,hiddenPause=false;
  const indexAt=seconds=>Math.max(0,Math.min(YEARS-1,Math.floor((Math.floor(seconds*FPS)+2)/FRAMES_PER_YEAR)));
  function showYear(index){
    if(index===lastIndex)return;lastIndex=index;
    const year=1986+index;yearEl.textContent=year;ndviEl.textContent=DATA.MU_SERIES.ndvi[index].toFixed(3);
    const phase=(DATA.PHASES||[]).find(p=>year>=p.start&&year<=p.end);
    phaseEl.textContent=phase?phase.start+'—'+phase.end+' · '+phase.name:'';
    bar.style.setProperty('--progress',(index/(YEARS-1)*100).toFixed(2)+'%');
  }
  function setButton(){const paused=video.paused||!!still;pauseButton.textContent=paused?'播放':'暂停';pauseButton.setAttribute('aria-label',paused?'播放开场短片':'暂停开场短片');pauseButton.setAttribute('aria-pressed',String(!paused));}
  function loop(){showYear(indexAt(video.currentTime));if(!video.paused&&!video.ended)raf=requestAnimationFrame(loop);}
  function finish(){cancelAnimationFrame(raf);showYear(YEARS-1);section.classList.add('is-done');setButton();}
  function staticLast(message){
    cancelAnimationFrame(raf);video.pause();video.removeAttribute('autoplay');video.style.display='none';
    if(!still){still=document.createElement('img');still.className=video.className;still.src='assets/video/opening-poster.jpg';still.alt='2025年原年度NDVI产品静态末帧';section.insertBefore(still,video);}
    section.classList.add('is-static');status.textContent=message;finish();
  }
  function clearStill(){if(still){still.remove();still=null;}video.style.display='';section.classList.remove('is-static');status.textContent='';}
  function play(restart){
    clearStill();section.classList.remove('is-done');
    if(video.networkState===HTMLMediaElement.NETWORK_NO_SOURCE)video.load();
    if(restart||video.ended){lastIndex=-1;video.currentTime=0;showYear(0);}
    const promise=video.play();if(promise&&promise.catch)promise.catch(()=>staticLast('短片未播放，当前显示2025年静态末帧；可点击播放重试。'));
  }
  pauseButton.addEventListener('click',()=>{if(video.paused||still)play(!!still);else video.pause();});
  video.addEventListener('play',()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(loop);setButton();});
  video.addEventListener('pause',()=>{cancelAnimationFrame(raf);setButton();});
  video.addEventListener('seeked',()=>showYear(indexAt(video.currentTime)));
  video.addEventListener('ended',finish);
  video.addEventListener('error',()=>staticLast('短片加载失败，当前显示2025年静态末帧；可重试或继续阅读。'));
  const sources=video.querySelectorAll('source');if(sources.length)sources[sources.length-1].addEventListener('error',()=>staticLast('短片加载失败，当前显示2025年静态末帧。'));
  document.querySelector('#openingReplay').addEventListener('click',()=>play(true));
  function advance(){video.pause();document.querySelector('#hero').scrollIntoView({behavior:reduced?'auto':'smooth'});}
  document.querySelector('#openingSkip').addEventListener('click',advance);
  document.querySelector('#openingNext').addEventListener('click',advance);
  const observer=new IntersectionObserver(entries=>document.body.classList.toggle('over-opening',entries[0].isIntersecting&&entries[0].intersectionRatio>.35),{threshold:[0,.35,.6]});observer.observe(section);
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&!video.paused){video.pause();hiddenPause=true;}else if(!document.hidden&&hiddenPause){hiddenPause=false;status.textContent='开场已暂停，点击播放继续。';}});
  window.OPENING={indexAt,getState:()=>({year:1986+lastIndex,ndvi:DATA.MU_SERIES.ndvi[lastIndex],paused:video.paused,currentTime:video.currentTime,staticImage:still?.getAttribute('src')||null,notice:status.textContent})};
  showYear(0);
  if(reduced){staticLast('已减少动态：展示2025年静态末帧。点击播放可手动观看。');return;}
  // HTML解析时可能已尝试完全部source；补查状态，避免错过早于脚本的error事件。
  if(video.error||video.networkState===HTMLMediaElement.NETWORK_NO_SOURCE){staticLast('短片加载失败，当前显示2025年静态末帧；可重试或继续阅读。');return;}
  if(video.readyState>=2)play(false);else video.addEventListener('canplay',()=>{if(video.currentTime===0&&video.paused&&!still)play(false);},{once:true});
})();
