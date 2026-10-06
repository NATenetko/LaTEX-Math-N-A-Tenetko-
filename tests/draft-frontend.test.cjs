'use strict';
const fs=require('node:fs'), vm=require('node:vm'), path=require('node:path'), assert=require('node:assert/strict');
class Element {
  constructor(){this.value='';this.children=[];this.listeners={};this.dataset={};this.disabled=false;this.textContent='';}
  addEventListener(t,f){this.listeners[t]=f;}
  append(e){this.children.push(e);}
  replaceChildren(){this.children=[];}
  setAttribute(){} setSelectionRange(){} pause(){}
  click(){if(!this.disabled)return this.listeners.click?.() ?? this.onclick?.();}
}
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(){
  const elements=new Map(), $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const bridge={audioDraftStatus:async()=>({ready:true}),chooseDraftFolder:async()=>({id:'folder',path:'/test'}),chooseDraftAudio:async()=>({files:[{id:'a',name:'a.wav'},{id:'b',name:'b.wav'}]}),transcribeDraft:async()=>({text:'Результат'}),writeDraftText:async()=>({files:['part.txt']}),onDraftProgress(){},cancelTranscription(){}};
  const document={getElementById:$,createElement:()=>new Element(),addEventListener(){},body:{classList:{contains:()=>false}}};
  const source=process.argv[2] || path.join(__dirname,'../audio-draft.js');
  vm.runInNewContext(fs.readFileSync(source,'utf8'),{window:{mathDesktop:bridge,addEventListener(){}},document,localStorage:{getItem:()=>null,setItem(){}},setTimeout});
  await tick(); await $('draft-folder').click();await tick();await $('draft-batch-open').click();
  return {$,bridge};
}
async function failedDirectSave(){
  const {$,bridge}=await setup();$('draft-output-mode').value='files';$('draft-output-limit').value='5000';$('draft-editor').value='Ручные правки';
  let recognitionCalls=0,saveCalls=0;
  bridge.transcribeDraft=async()=>{recognitionCalls++;return {error:'TXT не сохранён: диск заполнен',text:'Точный текст 😀 \\[X_1=Y^2\\]\n'};};
  await $('draft-batch-start').click();
  assert.equal($('draft-queue').children[0].dataset.state,'ошибка');
  assert.equal($('draft-queue').children[1].dataset.state,'ожидает');
  const preserved=$('draft-editor').value;
  bridge.writeDraftText=async data=>{saveCalls++;assert.equal(data.text,'Точный текст 😀 \\[X_1=Y^2\\]\n');assert.equal(data.base,'a');return {error:'Папка недоступна'};};
  await $('draft-batch-start').click();assert.equal(recognitionCalls,1);assert.equal($('draft-editor').value,preserved);assert.equal($('draft-queue').children[0].dataset.state,'ошибка');
  bridge.writeDraftText=async()=>{saveCalls++;return {files:['saved.txt']};};
  bridge.transcribeDraft=async()=>{recognitionCalls++;return {files:['second.txt'],characters:10};};
  await $('draft-batch-start').click();
  assert.equal(recognitionCalls,2);assert.equal(saveCalls,2);assert.equal($('draft-editor').value,preserved);
  assert($('draft-queue').children.every(e=>e.dataset.state==='done'));
}
async function failedRollover(){
  const {$,bridge}=await setup();$('draft-output-mode').value='draft';$('draft-output-limit').value='5000';
  let calls=0,saves=0,exported;
  bridge.transcribeDraft=async()=>{calls++;return {text:calls===1?'A'.repeat(5001):'Следующий файл'};};
  bridge.writeDraftText=async data=>{saves++;if(saves===1)return {error:'Диск заполнен'};exported=data.text;return {files:['saved.txt']};};
  await $('draft-batch-start').click();assert.equal($('draft-queue').children[0].dataset.state,'ошибка');assert.equal(calls,1);assert.equal($('draft-editor').value,'A'.repeat(5001));
  await $('draft-batch-start').click();assert.equal(calls,2);assert.equal(exported,'A'.repeat(5001));assert.equal($('draft-editor').value,'Следующий файл');
}
async function queueLockedBeforeAwait(){
  const {$,bridge}=await setup();$('draft-output-mode').value='draft';$('draft-output-limit').value='5000';$('draft-editor').value='x'.repeat(5001);
  const staleButtons=$('draft-queue').children[0].children.slice(1);
  let resolveSave,entered=false,calls=0;
  bridge.writeDraftText=()=>{entered=true;return new Promise(r=>resolveSave=r);};
  bridge.transcribeDraft=async()=>{calls++;return {text:'OK'};};
  const pending=$('draft-batch-start').click();await tick();assert(entered);
  assert($('draft-queue').children.every(e=>e.children.slice(1).every(b=>b.disabled)));
  // Even a stale callback must not mutate the queue or reset busy.
  staleButtons.forEach(b=>b.onclick());
  assert.equal($('draft-queue').children.length,2);assert($('draft-queue').children[0].children[0].textContent.startsWith('a.wav'));
  assert($('draft-batch-start').disabled);assert($('draft-batch-open').disabled);
  await $('draft-batch-start').listeners.click();assert.equal(calls,0);
  resolveSave({files:['saved.txt']});await pending;assert.equal(calls,2);assert(!$('draft-batch-open').disabled);
}
(async()=>{await failedDirectSave();await failedRollover();await queueLockedBeforeAwait();console.log('Draft frontend: failed saves remain retryable, no duplicate recognition/text, queue locked before async save.');})().catch(e=>{console.error(e);process.exitCode=1;});
