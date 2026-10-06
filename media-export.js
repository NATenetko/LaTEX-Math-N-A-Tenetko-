'use strict';
(function () {
  const WIDTH=960, HEIGHT=240;
  function cues(queue,timeline) {
    const result=[];
    timeline.segments.forEach((s,index) => {
      const piece=queue[index];
      if (!piece) throw Error('Очередь и аудио не совпадают');
      result.push({piece,time:s.start,charIndex:0,whole:piece.kind==='text' && !s.words.length});
      if (piece.kind==='text') for (const word of s.words) {
        result.push({piece,time:Math.min(timeline.duration,s.start+word.time),charIndex:word.index});
      }
    });
    return result.sort((a,b)=>a.time-b.time);
  }
  function drawText(context,focus) {
    context.fillStyle='#111'; context.fillRect(0,0,WIDTH,HEIGHT);
    let scale=1;
    const measure=() => {
      context.font=`600 ${64*scale}px Arial`; const center=context.measureText(focus.current).width;
      context.font=`${26*scale}px Arial`; const before=context.measureText(focus.before).width, after=context.measureText(focus.after).width;
      return {center,before,after,total:center+before+after+40};
    };
    let metrics=measure();
    if (metrics.total>WIDTH-48) { scale=(WIDTH-88)/metrics.total; metrics=measure(); }
    let x=(WIDTH-metrics.total)/2;
    context.textBaseline='middle'; context.fillStyle='#999'; context.font=`${26*scale}px Arial`;
    context.fillText(focus.before,x,HEIGHT/2); x+=metrics.before+20;
    context.fillStyle='#fff'; context.font=`600 ${64*scale}px Arial`; context.fillText(focus.current,x,HEIGHT/2); x+=metrics.center+20;
    context.fillStyle='#999'; context.font=`${26*scale}px Arial`; context.fillText(focus.after,x,HEIGHT/2);
  }
  async function drawMath(context,piece) {
    if (!piece.latex) throw Error('У формулы нет точного LaTeX. Видео не экспортировано.');
    context.fillStyle='#111'; context.fillRect(0,0,WIDTH,HEIGHT);
    if (!window.MathJax?.tex2svgPromise) throw Error('MathJax не готов: экспорт формулы остановлен');
    await window.MathJax.startup.promise;
    const node=await window.MathJax.tex2svgPromise(piece.latex,{display:true});
    if (node.querySelector('[data-mml-node="merror"]')) throw Error('В формуле есть ошибка MathJax. Исправьте её до экспорта видео.');
    const svg=node.querySelector('svg'); if (!svg) throw Error('Формула не отрисована');
    const [, , w,h]=svg.getAttribute('viewBox').split(/\s+/).map(Number);
    svg.setAttribute('xmlns','http://www.w3.org/2000/svg'); svg.setAttribute('width',String(w)); svg.setAttribute('height',String(h));
    svg.style.color='#fff'; svg.style.background='transparent';
    const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));
    try {
      const image=await new Promise((resolve,reject)=> { const img=new Image(); img.onload=()=>resolve(img); img.onerror=()=>reject(Error('Не удалось подготовить кадр формулы')); img.src=url; });
      const scale=Math.min((WIDTH-48)/w,(HEIGHT-40)/h);
      context.drawImage(image,(WIDTH-w*scale)/2,(HEIGHT-h*scale)/2,w*scale,h*scale);
    } finally { URL.revokeObjectURL(url); }
  }
  const api={cues,drawText,WIDTH,HEIGHT};
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  if (typeof window==='undefined') return;
  window.ArticleMediaExport={attach};
  function attach(reader) {
    const $=id=>document.getElementById(id), bridge=window.mathDesktop;
    let busy=false, token=null, cancelled=false, voicesReady=false;
    const status=$('media-status'), canvas=$('media-preview'), context=canvas.getContext('2d');
    function state(value) {
      busy=value; $('export-audio').disabled=value || !bridge?.prepareMedia || !voicesReady;
      $('export-video').disabled=value || !bridge?.prepareMedia || !voicesReady; $('export-cancel').hidden=!value;
    }
    state(false); drawText(context,{before:'',current:'960 × 240',after:''});
    bridge?.mediaVoices?.().then(result=>{
      if(result.error) throw Error(result.error);
      for(const lang of ['ru','en']) { const select=$('export-voice-'+lang); for(const v of result.voices.filter(v=>v.lang.startsWith(lang))) {const option=document.createElement('option'); option.value=v.id; option.textContent=v.name+' · '+v.lang; select.append(option);} if(!select.options.length) throw Error('Нет локального голоса '+lang); const saved=localStorage.getItem('tenetko-export-voice-'+lang); if([...select.options].some(o=>o.value===saved))select.value=saved; select.addEventListener('change',()=>localStorage.setItem('tenetko-export-voice-'+lang,select.value)); }
      voicesReady=true; state(false);
    }).catch(error=>{status.textContent=error.message;});
    bridge?.onMediaProgress?.(event=> {
      if (!busy) return; token=event.id;
      status.textContent=event.phase==='encoding'?'Кодирование MP4…':`Подготовка звука: ${event.progress || 0} / ${event.total || '—'}`;
    });
    async function exportMedia(kind) {
      if (busy) return;
      reader.stop(); cancelled=false; token=null; state(true); status.textContent='Подготовка экспорта…';
      try {
        const model=reader.getSnapshot();
        const selected=$('export-from-cursor').checked ? reader.fromPosition(model,reader.getCursor()) : model;
        if (!selected) throw Error('Сначала выберите позицию курсора');
        const queue=reader.buildQueue(selected,{readMath:$('reader-math').checked,readCode:$('reader-code').checked});
        if (!queue.length) throw Error('Нет текста для экспорта');
        const pieces=queue.map(p=>({text:p.speechText,lang:p.lang==='ru'?'ru-RU':'en-US',voice:$(`export-voice-${p.lang}`).value}));
        const result=await bridge.prepareMedia({kind,title:model.metadata.title,pieces,rate:Number($('reader-rate').value),pitch:Number($('reader-pitch').value),volume:Number($('reader-volume').value),pause:Number($('reader-gap').value)});
        if (result.cancelled) { status.textContent='Сохранение отменено'; return; }
        if (result.error) throw Error(result.error);
        if (kind==='audio') { status.textContent=`WAV сохранён · ${Math.round(result.duration)} сек.`; return; }
        token=result.id;
        const frames=cues(queue,result.timeline);
        canvas.hidden=false;
        let previous=null, count=0;
        for (const cue of frames) {
          if (cancelled) throw Error('Экспорт отменён');
          const focus=cue.piece.kind==='math' ? null : cue.whole ? {before:'',current:cue.piece.raw,after:''} : reader.sourceFocus(cue.piece,cue.charIndex);
          const key=focus ? JSON.stringify(focus) : cue.piece.latex;
          if (key===previous) continue; previous=key;
          if (focus) drawText(context,focus); else await drawMath(context,cue.piece);
          const added=await bridge.mediaFrame({id:token,time:cue.time,png:canvas.toDataURL('image/png')});
          if (added.error) throw Error(added.error);
          status.textContent=`Кадры визуализации: ${++count} / ${frames.length}`;
        }
        const done=await bridge.finishMedia(token); if (done.error) throw Error(done.error);
        const aligned=result.timeline.segments.some(s=>s.timing==='system-playback-aligned');
        status.textContent=`MP4 сохранён · 960×240 · ${Math.round(done.duration)} сек.${aligned?' · синхронизация по событиям системного голоса':''}`;
      } catch(error) {
        if (token) await bridge.cancelMedia(token);
        status.textContent=error.message || 'Не удалось экспортировать';
      } finally { token=null; state(false); }
    }
    $('export-audio').addEventListener('click',()=>exportMedia('audio'));
    $('export-video').addEventListener('click',()=>exportMedia('video'));
    $('export-cancel').addEventListener('click',async()=> { cancelled=true; await bridge.cancelMedia(token); });
    window.addEventListener('article-document-changed',()=> { if (busy) { cancelled=true; bridge.cancelMedia(token); } });
    if (!bridge?.prepareMedia) status.textContent='Экспорт медиа доступен в macOS-приложении 1.6';
  }
})();
