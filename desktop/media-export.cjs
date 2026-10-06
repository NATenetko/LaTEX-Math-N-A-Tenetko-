'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

function validate(data) {
  if (!data || !['audio', 'video'].includes(data.kind) || !Array.isArray(data.pieces) || !data.pieces.length || data.pieces.length > 20000) throw Error('Некорректный запрос экспорта');
  let size = 0;
  const pieces = data.pieces.map(p => {
    if (typeof p.text !== 'string' || !p.text.length || p.text.length > 50000 || !['ru-RU', 'en-US'].includes(p.lang) || (p.voice != null && (typeof p.voice !== 'string' || p.voice.length > 300))) throw Error('Некорректный фрагмент речи');
    size += p.text.length; return {text:p.text,lang:p.lang,voice:p.voice || null};
  });
  if (size > 2000000) throw Error('Слишком большой документ для экспорта');
  for (const [key,min,max] of [['rate',0.5,2],['pitch',0,2],['volume',0,1],['pause',0,3000]]) {
    if (!Number.isFinite(data[key]) || data[key]<min || data[key]>max) throw Error(`Проверьте настройку: ${key}`);
  }
  return {pieces,rate:data.rate,pitch:data.pitch,volume:data.volume,pause:data.pause,timing:data.kind==='video'};
}

module.exports = function register({ipcMain, dialog, getWindow, entryURL, smokeDir}) {
  let job = null;
  function authorized(event) {
    return event.sender === getWindow()?.webContents && event.senderFrame?.url === entryURL;
  }
  function current(event, id) {
    if (!authorized(event) || !job || job.id!==id || job.owner!==event.sender.id) throw Error('Недоступная операция экспорта');
    return job;
  }
  function progress(j, data) { if (!getWindow()?.isDestroyed()) getWindow().webContents.send('media:progress',{id:j.id,...data}); }
  async function cleanup(j) {
    if (job===j) job=null;
    if (j.child && j.child.exitCode===null) j.child.kill('SIGTERM');
    if (j.directory) await fs.rm(j.directory,{recursive:true,force:true});
  }
  function run(j, name, args, phase) {
    return new Promise((resolve,reject) => {
      const proc=spawn(path.join(__dirname,'bin',name), args, {stdio:['ignore','pipe','pipe']}); j.child=proc;
      // Bound unresponsive native services; cancellation remains available throughout.
      const timer=setTimeout(()=>{ stderr='Системный голос или кодировщик не отвечает. Попробуйте другой голос.'; proc.kill('SIGTERM'); }, Math.max(180000,(j.characters || 0)*1500));
      let stderr='', pending='';
      proc.stdout.on('data', chunk => {
        pending+=chunk.toString(); const lines=pending.split('\n'); pending=lines.pop();
        for (const line of lines) { try { progress(j,{phase,...JSON.parse(line)}); } catch (_) {} }
      });
      proc.stderr.on('data', chunk => { stderr=(stderr+chunk.toString()).slice(-5000); });
      proc.on('error',error=>{ clearTimeout(timer); reject(error); });
      proc.on('close',code => { clearTimeout(timer); j.child=null; code===0 ? resolve() : reject(Error(j.cancelled ? 'Экспорт отменён' : stderr || `Ошибка ${name}: ${code}`)); });
    });
  }
  ipcMain.handle('media:voices',async event=>{
    if(!authorized(event)) return {error:'Недоступно'};
    return new Promise(resolve=>execFile(path.join(__dirname,'bin','speech-export'),['--voices'],{timeout:15000,maxBuffer:1000000},(error,stdout)=>{try{resolve(error?{error:error.message}:{voices:JSON.parse(stdout)});}catch(e){resolve({error:e.message});}}));
  });
  ipcMain.handle('media:prepare', async (event,data) => {
    let j;
    try {
      if (!authorized(event) || job) throw Error('Другой экспорт уже выполняется');
      const request=validate(data);
      j={id:crypto.randomUUID(),owner:event.sender.id,directory:null,kind:data.kind,frames:[],child:null,cancelled:false,characters:request.pieces.reduce((n,p)=>n+p.text.length,0)}; job=j;
      j.directory=await fs.mkdtemp(path.join(os.tmpdir(),'tenetko-media-'));
      const ext=data.kind==='audio'?'wav':'mp4';
      const safe=String(data.title || 'Статья').replace(/[\/\\:\x00-\x1f]/g,'_').slice(0,100);
      const chosen=smokeDir ? {filePath:path.join(smokeDir,`export.${ext}`)} : await dialog.showSaveDialog(getWindow(),{title:data.kind==='audio'?'Сохранить озвучивание':'Сохранить видео 960×240',defaultPath:`${safe}.${ext}`,filters:[{name:data.kind==='audio'?'WAV audio':'MP4 video',extensions:[ext]}]});
      if (chosen.canceled || !chosen.filePath) { await cleanup(j); return {cancelled:true}; }
      if (j.cancelled || job!==j) throw Error('Экспорт отменён');
      j.destination=chosen.filePath;
      await fs.writeFile(path.join(j.directory,'request.json'),JSON.stringify(request));
      progress(j,{phase:'speech',progress:0,total:request.pieces.length});
      await run(j,'speech-export',[path.join(j.directory,'request.json'),j.directory],'speech');
      if (j.cancelled) throw Error('Экспорт отменён');
      const timeline=JSON.parse(await fs.readFile(path.join(j.directory,'timeline.json'),'utf8')); j.timeline=timeline;
      if (data.kind==='audio') {
        await fs.copyFile(path.join(j.directory,'audio.wav'),j.destination); await cleanup(j);
        return {saved:true,path:j.destination,duration:timeline.duration};
      }
      return {id:j.id,timeline};
    } catch(error) { if(j && job===j) await cleanup(j); return {error:error.message}; }
  });
  ipcMain.handle('media:frame', async(event,data) => {
    try {
      const j=current(event,data?.id);
      if (j.cancelled || j.kind!=='video' || j.frames.length>100000 || !Number.isFinite(data.time) || data.time<0 || data.time>j.timeline.duration || (j.frames.length && data.time<j.frames.at(-1).time)) throw Error('Некорректный кадр');
      if (typeof data.png !== 'string' || !data.png.startsWith('data:image/png;base64,') || data.png.length>6000000) throw Error('Некорректное изображение');
      const bytes=Buffer.from(data.png.slice(22),'base64');
      if (bytes.toString('hex',0,8)!=='89504e470d0a1a0a' || bytes.readUInt32BE(16)!==960 || bytes.readUInt32BE(20)!==240) throw Error('Размер кадра должен быть 960×240');
      const file=`frame-${j.frames.length}.png`; await fs.writeFile(path.join(j.directory,file),bytes); j.frames.push({file,time:data.time}); return {ok:true};
    } catch(error) { return {error:error.message}; }
  });
  ipcMain.handle('media:finish', async(event,id) => {
    let j;
    try {
      j=current(event,id); if (!j.frames.length) throw Error('Нет кадров для видео');
      await fs.writeFile(path.join(j.directory,'video.json'),JSON.stringify({audio:'audio.wav',output:'video.mp4',width:960,height:240,fps:24,duration:j.timeline.duration,frames:j.frames}));
      progress(j,{phase:'encoding'}); await run(j,'video-export',[path.join(j.directory,'video.json')],'encoding');
      if (j.cancelled) throw Error('Экспорт отменён');
      await fs.copyFile(path.join(j.directory,'video.mp4'),j.destination);
      const result={saved:true,path:j.destination,duration:j.timeline.duration,width:960,height:240,frames:j.frames.length};
      if (smokeDir) await fs.writeFile(path.join(smokeDir,'media-timeline.json'),JSON.stringify(j.timeline,null,2));
      await cleanup(j); return result;
    } catch(error) { if(j && job===j) await cleanup(j); return {error:error.message}; }
  });
  ipcMain.handle('media:cancel', async(event,id) => {
    if (!authorized(event) || !job || (id && id!==job.id)) return {ok:false};
    const j=job; j.cancelled=true;
    if (j.child) j.child.kill('SIGTERM'); else await cleanup(j);
    return {ok:true};
  });
  return {close:async() => { if(job) { job.cancelled=true; await cleanup(job); } }};
};
module.exports.validate = validate;
