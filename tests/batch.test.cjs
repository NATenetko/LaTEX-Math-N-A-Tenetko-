'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
const register=require('../desktop/audio-draft.cjs'), {splitText}=register;
(async()=>{
  const text=('Имена и формулы: \\[M_{n+2}=100M_n\\] 😀\n').repeat(420);
  for(const limit of [0,5000,10000]) {const parts=splitText(text,limit); assert.equal(parts.join(''),text); assert(parts.every(s=>!limit || s.length<=limit)); assert(parts.every(s=>!/[\uD800-\uDBFF]$/.test(s)));}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tenetko-batch-test-'));
  const handlers={}, wc={id:77}, event={sender:wc,senderFrame:{url:'file:///editor'}};
  register({ipcMain:{handle:(key,fn)=>handlers[key]=fn},getWindow:()=>({webContents:wc}),entryURL:'file:///editor',dialog:{showOpenDialog:async()=>({filePaths:[directory]})}});
  const folder=await handlers['draft:folder'](event);
  const first=await handlers['draft:write'](event,{folderId:folder.id,text,limit:5000,base:'../пример'});
  assert(!first.error); assert(first.files.every(f=>path.dirname(f)===directory));
  assert.equal((await Promise.all(first.files.map(f=>fs.readFile(f,'utf8')))).join(''),text);
  const second=await handlers['draft:write'](event,{folderId:folder.id,text,limit:5000,base:'../пример'});
  assert(second.files.every(f=>!first.files.includes(f)));
  assert((await handlers['draft:write']({...event,sender:{}},{folderId:folder.id,text,limit:5000})).error);
  assert((await handlers['draft:write'](event,{folderId:'arbitrary-path',text,limit:5000})).error);
  await fs.rm(directory,{recursive:true,force:true});
  assert((await handlers['draft:write'](event,{folderId:folder.id,text,limit:5000})).error);
  console.log('Batch: exact Unicode splitting, ordered parts, exclusive filenames, selected-directory security and write errors passed');
})().catch(e=>{console.error(e); process.exitCode=1;});
