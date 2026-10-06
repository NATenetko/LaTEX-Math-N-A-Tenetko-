'use strict';
(() => {
  const $=id=>document.getElementById(id), bridge=window.mathDesktop;
  const editor=$('draft-editor'), status=$('draft-status'), audio=$('draft-audio-player');
  let selected=null, busy=false, ready=false, originals=[], folder=null, queue=[], stopping=false, runningBatch=false;
  const key='tenetko-audio-draft-v1';
  try { const saved=JSON.parse(localStorage.getItem(key)); if(saved) { editor.value=saved.text || ''; originals=Array.isArray(saved.originals)?saved.originals:[]; } } catch {}
  function showHistory() { const history=$('draft-history'); history.textContent=originals.length ? `Добавлено расшифровок: ${originals.length} · ${originals.map(o=>o.name).join(' · ')}` : 'Новые расшифровки добавляются в конец. Импорт аудио не очищает черновик.'; }
  function save() { try { localStorage.setItem(key,JSON.stringify({text:editor.value,originals})); $('draft-storage-warning').hidden=true; } catch { $('draft-storage-warning').hidden=false; } }
  function state(value) { busy=value; $('draft-transcribe').disabled=value || !selected || !ready; $('draft-audio-open').disabled=value || !bridge; $('draft-cancel').hidden=!value; $('draft-new').disabled=value; $('draft-batch-open').disabled=value || !bridge; $('draft-batch-start').disabled=value || !ready || !queue.some(f=>f.state!=='done'); for(const id of ['draft-output-mode','draft-output-limit','draft-folder'])$(id).disabled=value || !bridge; renderQueue(); }
  function renderQueue() {
    $('draft-queue').replaceChildren();
    queue.forEach((file,index)=>{const li=document.createElement('li'); li.dataset.state=file.state; const label=document.createElement('span'); label.textContent=`${file.name} — ${file.state==='done'?'готово':file.state || 'ожидает'}`; li.append(label);
      for(const [label,delta] of [['↑',-1],['↓',1]]) {const b=document.createElement('button'); b.type='button'; b.textContent=label; b.disabled=busy || index+delta<0 || index+delta>=queue.length; b.setAttribute('aria-label',label==='↑'?'Выше в очереди':'Ниже в очереди'); b.onclick=()=>{if(busy)return; [queue[index],queue[index+delta]]=[queue[index+delta],queue[index]]; renderQueue();}; li.append(b);} const remove=document.createElement('button'); remove.type='button'; remove.textContent='Убрать'; remove.disabled=busy; remove.onclick=()=>{if(busy)return; queue.splice(index,1); state(false);}; li.append(remove); $('draft-queue').append(li);});
  }
  async function chooseFolder() {const result=await bridge.chooseDraftFolder(); if(result.error)throw Error(result.error); if(result.cancelled)return false; folder=result; $('draft-folder-name').textContent=result.path; return true;}
  $('draft-folder').addEventListener('click',()=>chooseFolder().catch(e=>status.textContent=e.message));
  $('draft-batch-open').addEventListener('click',async()=>{try {save(); const result=await bridge.chooseDraftAudio({multiple:true}); if(result.error)throw Error(result.error); if(result.cancelled)return; queue.push(...result.files.map(f=>({...f,state:'ожидает'}))); renderQueue(); state(false); status.textContent='Записи добавлены в очередь. Черновик сохранён.';} catch(e){status.textContent=e.message;}});
  function appendResult(file,result) {file.receivedResult=true; originals.push({name:file.name,text:result.text,segments:result.segments,date:new Date().toISOString(),model:result.model}); const previous=editor.value; editor.value=previous+(previous?'\n\n':'')+result.text; save(); showHistory(); editor.setSelectionRange(editor.value.length,editor.value.length); editor.scrollTop=editor.scrollHeight;}
  async function rollDraft(limit) {
    if(!limit || editor.value.length<limit)return;
    editor.readOnly=true;
    try {const written=await bridge.writeDraftText({folderId:folder.id,text:editor.value,limit,base:'Черновик'}); if(written.error)throw Error('TXT не сохранён: '+written.error+'. Черновик не очищен.'); editor.value=''; originals=[]; save(); showHistory(); $('draft-batch-status').textContent=`Черновик сохранён в ${written.files.length} TXT. Начат новый черновик. Папка: ${folder.path}`;} finally {editor.readOnly=false;}
  }
  async function recognize(file,mode,limit) {
    // Retry only the failed save, not recognition or insertion into the draft.
    if(file.pendingResult) {
      if(mode==='files') {
        const written=await bridge.writeDraftText({folderId:folder.id,text:file.pendingResult.text,limit,base:file.name.replace(/\.[^.]+$/,'')});
        if(written.error)throw Error('TXT не сохранён: '+written.error+'. Расшифровка сохранена в черновике.');
        file.files=written.files;
        $('draft-batch-status').textContent=`${file.name}: сохранено ${written.files.length} TXT. ${folder.path}`;
      } else await rollDraft(limit);
      delete file.pendingResult;
      return;
    }
    const result=await bridge.transcribeDraft({id:file.id,language:$('draft-language').value,prompt:$('draft-prompt').value,output:mode==='files'?{folderId:folder.id,limit}:undefined});
    if(result.error) {if(typeof result.text==='string') {file.pendingResult=result; appendResult(file,result);} throw Error(result.error);}
    if(mode==='files') {file.files=result.files; $('draft-batch-status').textContent=`${file.name}: сохранено ${result.files.length} TXT · ${result.characters} знаков. ${folder.path}`; return;}
    if(typeof result.text!=='string')throw Error('Распознавание не вернуло текст. Черновик сохранён.');
    if(!result.text.trim()) {status.textContent='Речь не распознана. Предыдущий текст сохранён.'; return;}
    file.pendingResult=result;
    appendResult(file,result); await rollDraft(limit);
    delete file.pendingResult;
    status.textContent=`Текст «${file.name}» добавлен в конец. Предыдущие записи и правки сохранены.`;
  }
  async function settings() {const mode=$('draft-output-mode').value, limit=Number($('draft-output-limit').value); if((mode==='files' || limit) && !folder && !await chooseFolder())return null; return {mode,limit};}
  $('draft-batch-start').addEventListener('click',async()=>{
    if(busy)return;
    stopping=false; runningBatch=true; state(true); audio.pause();
    try {const options=await settings(); if(!options || stopping)return; await rollDraft(options.mode==='draft'?options.limit:0);
      for(let i=0;i<queue.length;i++) {const file=queue[i]; if(stopping)break; if(file.state==='done')continue; file.state='распознаётся'; renderQueue(); status.textContent=`Файл ${i+1} из ${queue.length}: ${file.name}`;
        try {await recognize(file,options.mode,options.limit); file.state='done';}catch(e){file.state=stopping?'отменён':'ошибка'; renderQueue(); throw e;} renderQueue();}
      status.textContent=stopping?'Очередь остановлена. Завершённые результаты сохранены.':'Очередь завершена. Результаты сохранены.';
    } catch(e){status.textContent=e.message;} finally {runningBatch=false; state(false); renderQueue();}
  });
  editor.addEventListener('input',save);
  window.addEventListener('keydown',e=>{
    if(!document.body.classList.contains('draft-mode') || !(e.metaKey || e.ctrlKey)) return;
    if(e.key.toLowerCase()==='s') {e.preventDefault(); e.stopImmediatePropagation(); $('draft-save').click();}
    else if(e.shiftKey && e.key.toLowerCase()==='c') {e.preventDefault(); e.stopImmediatePropagation(); $('draft-copy').click();}
  },true);
  $('audio-draft-tab').addEventListener('click',()=>{ document.dispatchEvent(new CustomEvent('workspace-tab-change',{detail:'draft'})); document.body.classList.add('draft-mode'); $('audio-draft-panel').hidden=false; $('audio-draft-tab').setAttribute('aria-selected','true'); });
  document.addEventListener('workspace-tab-change',e=>{ if(e.detail!=='draft') { document.body.classList.remove('draft-mode'); audio.pause(); } });
  $('draft-audio-open').addEventListener('click',async()=>{
    save();
    try { const result=await bridge.chooseDraftAudio(); if(result.error) throw Error(result.error); if(result.cancelled) return; selected=result; $('draft-audio-name').textContent=result.name; audio.src=result.url; audio.hidden=false; state(false); status.textContent='Запись загружена. Предыдущий текст сохранён; новая расшифровка добавится в конец.'; } catch(e) {status.textContent=e.message;}
  });
  bridge?.onDraftProgress?.(data=>{ if(busy) {const current=queue.find(f=>f.state==='распознаётся'); const prefix=runningBatch && current?`${queue.indexOf(current)+1} / ${queue.length} · ${current.name}: `:''; status.textContent=prefix+(data.phase==='convert'?'Подготовка аудио…':`Локальное распознавание: ${data.percent || 0}% · можно редактировать черновик`);} });
  $('draft-transcribe').addEventListener('click',async()=>{
    if(busy || !selected) return;
    audio.pause(); stopping=false; state(true); status.textContent='Загрузка локальной модели…';
    try {
      const options=await settings(); if(!options || stopping)return;
      await rollDraft(options.mode==='draft'?options.limit:0);
      if(!stopping)await recognize(selected,options.mode,options.limit);
      if(options.mode==='files')status.textContent='Результат сохранён в TXT. Черновик не изменён.';
    } catch(e) {status.textContent=e.message;} finally {state(false);}
  });
  $('draft-cancel').addEventListener('click',()=>{stopping=true; bridge.cancelTranscription();});
  $('draft-new').addEventListener('click',()=>{ if(editor.value && !confirm('Очистить черновик? Сохраните нужный текст в TXT перед очисткой.')) return; editor.value=''; originals=[]; save(); showHistory(); });
  $('draft-save').addEventListener('click',()=>{ const url=URL.createObjectURL(new Blob([editor.value],{type:'text/plain;charset=utf-8'})); const a=document.createElement('a'); a.href=url; a.download='Черновик.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),10000); });
  $('draft-copy').addEventListener('click',async()=>{ try {await navigator.clipboard.writeText(editor.value); status.textContent='Черновик скопирован';} catch {editor.focus(); editor.select(); status.textContent='Нажмите Cmd+C';} });
  $('draft-to-document').addEventListener('click',()=>{
    if(!editor.value.trim()) {status.textContent='Черновик пуст'; return;}
    if(!confirm('Открыть черновик как новую статью? Текущий документ будет заменён — предварительно сохраните его проект. Черновик останется.')) return;
    const dt=new DataTransfer(); dt.items.add(new File([editor.value],'Черновик.md',{type:'text/markdown'})); const input=$('file-input'); input.files=dt.files; input.dispatchEvent(new Event('change')); $('document-tab').click();
  });
  state(false); showHistory();
  if(bridge) bridge.audioDraftStatus().then(result=>{ready=result.ready; status.textContent=result.message || result.error; state(false);}).catch(e=>{status.textContent=e.message;});
  else status.textContent='Локальное распознавание доступно в приложении macOS 1.6. Черновик можно редактировать здесь.';
})();
