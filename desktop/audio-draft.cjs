'use strict';
const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const crypto=require('node:crypto');
async function locate() {
  const candidates=['/opt/homebrew/bin/whisper-cli','/usr/local/bin/whisper-cli'];
  let binary=null;
  for (const file of candidates) { try { await fs.access(file); binary=file; break; } catch {} }
  const base=path.join(os.homedir(),'Library','Application Support','Dictation');
  let model=path.join(base,'models','ggml-large-v3-turbo-q5_0.bin');
  try { const config=JSON.parse(await fs.readFile(path.join(base,'config.json'),'utf8')); if(typeof config.model==='string' && path.isAbsolute(config.model)) model=config.model; } catch {}
  let ready=false; try { ready=!!binary && (await fs.stat(model)).size>10000000; } catch {}
  let ffmpeg=null; for(const file of ['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg']) {try{await fs.access(file); ffmpeg=file; break;}catch{}}
  return {ready,binary,model,ffmpeg};
}
function splitText(text,limit) {
  if(!limit || text.length<=limit) return [text];
  const parts=[]; let start=0;
  while(start<text.length) {
    let end=Math.min(start+limit,text.length);
    if(end<text.length) {
      if(/[\uD800-\uDBFF]/.test(text[end-1]))end--;
      const newline=text.lastIndexOf('\n',end-1), space=text.lastIndexOf(' ',end-1), boundary=Math.max(newline,space)+1;
      if(boundary>start+limit*0.7)end=boundary;
    }
    parts.push(text.slice(start,end)); start=end;
  }
  return parts;
}
module.exports=function register({ipcMain,dialog,getWindow,entryURL,smokeDir}) {
  let selected=null, task=null, smokeChoices=0; const inputs=new Map(), folders=new Map();
  const authorized=e=>e.sender===getWindow()?.webContents && e.senderFrame?.url===entryURL;
  const send=data=>{ const w=getWindow(); if(w && !w.isDestroyed()) w.webContents.send('draft:progress',data); };
  async function clean(t) { if(task===t) task=null; if(t.child) t.child.kill('SIGTERM'); if(t.directory) await fs.rm(t.directory,{recursive:true,force:true}); }
  function run(t,binary,args,phase) {
    return new Promise((resolve,reject)=>{
      const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']}); t.child=child;
      let output='', errors='';
      const timer=setTimeout(()=>{ t.timedOut=true; child.kill('SIGTERM'); },12*60*60*1000);
      child.stdout.on('data',b=>{ output=(output+b.toString()).slice(-1000000); });
      child.stderr.on('data',b=>{ errors=(errors+b.toString()).slice(-5000); const matches=[...errors.matchAll(/progress\s*=\s*(\d+)%/g)]; if(matches.length) send({phase,percent:Number(matches.at(-1)[1])}); });
      child.on('error',e=>{clearTimeout(timer); reject(e);});
      child.on('close',code=>{ clearTimeout(timer); t.child=null; code===0 && !t.cancelled ? resolve(output) : reject(Error(t.cancelled?'Распознавание отменено':t.timedOut?'Превышено время распознавания':errors || 'Ошибка распознавания')); });
    });
  }
  ipcMain.handle('draft:status',async e=>{ if(!authorized(e)) return {error:'Недоступно'}; const s=await locate(); return {ready:s.ready,message:s.ready?'Локальный Whisper готов. Новые модели не нужны.':'Не найдены установленный whisper-cli или модель из «Диктовки». Импорт и редактор доступны, распознавание отключено.'}; });
  ipcMain.handle('draft:choose',async(e,options)=>{
    if(!authorized(e) || task) return {error:'Дождитесь завершения распознавания'};
    const smokeFile=process.argv.includes('--multi-audio-smoke') && smokeChoices>0?'export-second.wav':process.argv.includes('--import-format')?'import.'+process.argv[process.argv.indexOf('--import-format')+1]:'export.wav';
    const result=smokeDir ? {filePaths:options?.multiple?[path.join(smokeDir,'export.wav'),path.join(smokeDir,'export-second.wav')]:[path.join(smokeDir,smokeFile)]} : await dialog.showOpenDialog(getWindow(),{title:'Импорт голосовых записей',properties:options?.multiple?['openFile','multiSelections']:['openFile'],filters:[{name:'Audio',extensions:['ogg','oga','mp3','wav','m4a','aif','aiff','flac']}]});
    if(result.canceled) return {cancelled:true};
    if(result.filePaths.length>100) return {error:'Выберите не более 100 записей за один раз'};
    const files=[];
    for(const file of result.filePaths) {const stat=await fs.stat(file); if(!stat.isFile() || stat.size>1024*1024*1024)return {error:`Файл ${path.basename(file)} превышает 1 ГиБ или недоступен`}; files.push({id:crypto.randomUUID(),file,name:path.basename(file),url:pathToFileURL(file).href});}
    for(const f of files)inputs.set(f.id,f);
    selected=files[0]; smokeChoices++; return {...selected,files:files.map(({file,...f})=>f)};
  });
  async function writeText(data) {
    const directory=folders.get(data?.folderId);
    if(!directory || typeof data.text!=='string' || ![0,5000,10000].includes(data.limit))throw Error('Проверьте папку и размер частей TXT');
    const base=String(data.base || 'Черновик').replace(/[\/\\:\x00-\x1f]/g,'_').slice(0,80);
    const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8);
    const parts=splitText(data.text,data.limit), files=[];
    for(let n=0;n<parts.length;n++) {
      const file=path.join(directory,`${base}-${id}${parts.length>1?'-часть-'+String(n+1).padStart(3,'0'):''}.txt`);
      const handle=await fs.open(file,'wx');
      try {await handle.writeFile(parts[n],'utf8'); await handle.sync();} finally {await handle.close();}
      files.push(file);
    }
    return files;
  }
  ipcMain.handle('draft:folder',async e=>{
    if(!authorized(e))return {error:'Недоступно'};
    const result=smokeDir?{filePaths:[path.join(smokeDir,'batch-txt')]}:await dialog.showOpenDialog(getWindow(),{title:'Папка для автоматически сохраняемых TXT',properties:['openDirectory','createDirectory']});
    if(result.canceled)return {cancelled:true};
    const directory=result.filePaths[0]; if(smokeDir)await fs.mkdir(directory,{recursive:true});
    const id=crypto.randomUUID(); folders.set(id,directory); return {id,path:directory};
  });
  ipcMain.handle('draft:write',async(e,data)=>{try{if(!authorized(e))throw Error('Недоступно'); return {files:await writeText(data)};}catch(error){return {error:error.message};}});
  ipcMain.handle('draft:transcribe',async(e,data)=>{
    let t;
    try {
      const input=inputs.get(data?.id);
      if(!authorized(e) || task || !input) throw Error('Сначала импортируйте аудиофайл');
      if(!['ru','en','auto'].includes(data.language) || typeof data.prompt!=='string' || data.prompt.length>2000) throw Error('Некорректные настройки');
      if(data.output && (!folders.has(data.output.folderId) || ![0,5000,10000].includes(data.output.limit)))throw Error('Выберите папку для TXT');
      t={child:null,directory:null,cancelled:false}; task=t;
      const engine=await locate(); if(!engine.ready) throw Error('Локальный Whisper недоступен');
      t.directory=await fs.mkdtemp(path.join(os.tmpdir(),'tenetko-transcribe-'));
      if(t.cancelled) throw Error('Распознавание отменено');
      const wav=path.join(t.directory,'input.wav'), output=path.join(t.directory,'transcript');
      send({phase:'convert'});
      if(engine.ffmpeg) await run(t,engine.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-i',input.file,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav],'convert');
      else if(/\.(ogg|oga)$/i.test(input.file)) throw Error('Для OGG/Opus необходим локальный FFmpeg. На этом Mac он не найден. Выберите WAV или MP3.');
      else await run(t,'/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',input.file,wav],'convert');
      if(t.cancelled) throw Error('Распознавание отменено');
      send({phase:'recognize',percent:0});
      const args=['-m',engine.model,'-f',wav,'-l',data.language,'-otxt','-oj','-of',output,'-nt','-pp','-t',String(Math.min(8,Math.max(2,os.cpus().length-2)))];
      if(data.prompt) args.push('--prompt',data.prompt);
      await run(t,engine.binary,args,'recognize');
      const text=await fs.readFile(output+'.txt','utf8');
      if(data.output) {
        try {const files=await writeText({...data.output,text,base:path.parse(input.name).name}); await clean(t); return {files,characters:text.length,model:path.basename(engine.model)};}
        catch(error) {await clean(t); return {error:'TXT не сохранён: '+error.message+'. Расшифровка оставлена в черновике; очередь остановлена.',text,model:path.basename(engine.model)};}
      }
      let segments=[]; try { segments=JSON.parse(await fs.readFile(output+'.json','utf8')).transcription || []; } catch {}
      await clean(t); return {text,segments,model:path.basename(engine.model)};
    } catch(error) { if(t) await clean(t); return {error:error.message}; }
  });
  ipcMain.handle('draft:cancel',async e=>{ if(!authorized(e) || !task) return {ok:false}; task.cancelled=true; if(task.child) task.child.kill('SIGTERM'); return {ok:true}; });
  return {close:async()=>{if(task) {task.cancelled=true; await clean(task);}}};
};
module.exports.locate=locate;
module.exports.splitText=splitText;
