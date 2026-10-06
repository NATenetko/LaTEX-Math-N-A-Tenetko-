'use strict';
const fs=require('node:fs/promises'), path=require('node:path'), assert=require('node:assert/strict');
const {createDocumentFromMarkdown}=require('../app.js');
module.exports=async(win,output)=>{
  await fs.mkdir(output,{recursive:true});
  const project=createDocumentFromMarkdown(String.raw`Н.А. Тенетко

Основание и статус формулировки.

\[C_{10}^2=I\]

Hello world.`).document;
  project.metadata.title='Media export regression '+Date.now();
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const wait=async(fn,ms=120000)=>{const end=Date.now()+ms; while(!fn()){if(Date.now()>end)throw Error('UI timeout: '+document.querySelector('#media-status').textContent); await new Promise(r=>setTimeout(r,100));}};
    const dt=new DataTransfer(); dt.items.add(new File([${JSON.stringify(JSON.stringify(project))}],'media.json',{type:'application/json'})); const input=document.querySelector('#file-input'); input.files=dt.files; input.dispatchEvent(new Event('change'));
    await wait(()=>document.querySelector('#title-input').value===${JSON.stringify(project.metadata.title)});
    await MathJax.startup.promise;
    const original=localStorage.getItem('ai-math-document-editor-v1');
    document.querySelector('#reader-open').click();
    await wait(()=>speechSynthesis.getVoices().length>0,15000);
    const voices=speechSynthesis.getVoices();
    const ids={};
    for(const lang of ['ru','en']) { const v=voices.find(v=>v.localService && v.lang.startsWith(lang)); if(!v)throw Error('No local '+lang+' voice'); const sel=document.querySelector('#reader-voice-'+lang); sel.value=v.voiceURI; ids[lang]=v.voiceURI; }
    document.querySelector('#reader-gap').value=100;
    await wait(()=>!document.querySelector('#export-audio').disabled);
    ids.exportRU=document.querySelector('#export-voice-ru').value; ids.exportEN=document.querySelector('#export-voice-en').value;
    const exports=[];
    for(const kind of ${JSON.stringify(process.argv.includes('--draft-only')?[]:['audio','video'])}) {
      document.querySelector('#export-'+kind).click();
      await wait(()=>!document.querySelector('#export-'+kind).disabled);
      const message=document.querySelector('#media-status').textContent;
      if(!message.includes('сохранён'))throw Error(message);
      exports.push(message);
    }
    let mediaCancellation=false;
    if(exports.length) {
      document.querySelector('#export-audio').click(); await new Promise(r=>setTimeout(r,80)); document.querySelector('#export-cancel').click();
      await wait(()=>!document.querySelector('#export-audio').disabled,15000);
      mediaCancellation=document.querySelector('#media-status').textContent.includes('отмен');
      if(!mediaCancellation)throw Error('Media cancellation failed');
    }
    if(localStorage.getItem('ai-math-document-editor-v1')!==original)throw Error('Media export modified document');
    document.querySelector('#audio-draft-tab').click();
    const draft=document.querySelector('#draft-editor'); draft.value=${JSON.stringify(String.raw`Тестовый черновик.
\[C_{10}^2=I\]`)}; draft.dispatchEvent(new Event('input'));
    const storageMethod=Storage.prototype.setItem;
    try { Storage.prototype.setItem=()=>{throw Error('Simulated quota exceeded');}; draft.dispatchEvent(new Event('input')); if(document.querySelector('#draft-storage-warning').hidden)throw Error('Autosave failure hidden'); }
    finally {Storage.prototype.setItem=storageMethod;}
    draft.dispatchEvent(new Event('input')); if(!document.querySelector('#draft-storage-warning').hidden)throw Error('Autosave recovery failed');
    if(document.querySelector('#audio-draft-panel').hidden || !document.body.classList.contains('draft-mode'))throw Error('Draft tab unavailable');
    const engine=await mathDesktop.audioDraftStatus();
    if(!engine.ready)throw Error('Local Whisper not found');
    document.querySelector('#draft-audio-open').click();
    await wait(()=>!document.querySelector('#draft-transcribe').disabled);
    const audio=document.querySelector('#draft-audio-player'); await wait(()=>Number.isFinite(audio.duration) && audio.duration>0);
    await audio.play(); await wait(()=>audio.currentTime>0.05,10000); audio.pause();
    document.querySelector('#draft-transcribe').click();
    await wait(()=>!document.querySelector('#draft-transcribe').disabled,180000);
    if(!document.querySelector('#draft-status').textContent.includes('добавлен'))throw Error(document.querySelector('#draft-status').textContent);
    if(!draft.value.startsWith('Тестовый черновик.'))throw Error('Transcription overwrote draft');
    if(draft.value.length<50)throw Error('Empty transcription');
    let transcript=draft.value, multiAudio=false;
    if(${process.argv.includes('--multi-audio-smoke')}) {
      const first=transcript;
      document.querySelector('#draft-audio-open').click();
      await wait(()=>document.querySelector('#draft-audio-name').textContent==='export-second.wav');
      if(draft.value!==first)throw Error('Import of second audio cleared the first transcript');
      document.querySelector('#draft-transcribe').click();
      const edited=first+'\\nРучная правка во время второй расшифровки.';
      draft.value=edited; draft.dispatchEvent(new Event('input'));
      await wait(()=>!document.querySelector('#draft-transcribe').disabled,180000);
      if(!draft.value.startsWith(edited+'\\n\\n') || draft.value.length<=edited.length+2)throw Error('Second transcription overwrote previous text or edits');
      const stored=JSON.parse(localStorage.getItem('tenetko-audio-draft-v1'));
      if(stored.text!==draft.value || stored.originals.at(-2).name!=='export.wav' || stored.originals.at(-1).name!=='export-second.wav')throw Error('Multi-file draft was not saved');
      transcript=draft.value; multiAudio=true;
    }
    document.querySelector('#draft-transcribe').click();
    await new Promise(r=>setTimeout(r,80)); document.querySelector('#draft-cancel').click();
    await wait(()=>!document.querySelector('#draft-transcribe').disabled,15000);
    if(!document.querySelector('#draft-status').textContent.includes('отменено') || draft.value!==transcript)throw Error('Cancellation did not preserve draft');
    document.querySelector('#document-tab').click();
    if(document.body.classList.contains('draft-mode') || !document.querySelector('#audio-draft-panel').hidden)throw Error('Draft tab did not close');
    if(localStorage.getItem('ai-math-document-editor-v1')!==original)throw Error('Draft altered article');
    document.querySelector('#audio-draft-tab').click();
    document.querySelector('#draft-save').click();
    return {exports,ids,engine,transcript,multiAudio,mediaCancellation,cancellationPassed:true,sourceUnchanged:true,draftSaved:!!localStorage.getItem('tenetko-audio-draft-v1')};
  })()`);
  if(result.multiAudio) {
    await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve); win.webContents.reload();});
    const restored=await win.webContents.executeJavaScript(`(() => { document.querySelector('#audio-draft-tab').click(); return document.querySelector('#draft-editor').value; })()`);
    assert.equal(restored,result.transcript,'Accumulated draft must survive reload');
    result.restoredAfterReload=true;
  }
  const formatIndex=process.argv.indexOf('--import-format');
  await fs.writeFile(path.join(output,formatIndex>=0?'import-'+process.argv[formatIndex+1]+'-report.json':'media-report.json'),JSON.stringify(result,null,2));
  let saved; for(let i=0;i<50;i++){try{saved=await fs.readFile(path.join(output,'Черновик.txt'),'utf8'); if(saved===result.transcript)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.equal(saved,result.transcript,'TXT export must equal edited draft exactly');
  const timeline=JSON.parse(await fs.readFile(path.join(output,'media-timeline.json'),'utf8'));
  assert(timeline.duration>0); assert(timeline.segments.every(s=>s.words.every(w=>w.time>=0 && w.time<=s.duration+0.01)));
  assert(timeline.segments.every(s=>[result.ids.exportRU,result.ids.exportEN].includes(s.voice)),'Export must use explicitly selected native voices');
  await fs.writeFile(path.join(output,'media.png'),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(result));
};
