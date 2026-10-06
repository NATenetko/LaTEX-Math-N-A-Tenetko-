'use strict';
const fs=require('node:fs/promises'), path=require('node:path'), assert=require('node:assert/strict');
module.exports=async(win,output)=>{
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const $=id=>document.getElementById(id), wait=async(fn,ms=180000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('Timeout: '+$('draft-status').textContent);await new Promise(r=>setTimeout(r,100));}};
    $('audio-draft-tab').click(); await wait(()=>$('draft-status').textContent.includes('готов'));
    const editor=$('draft-editor'), originalArticle=localStorage.getItem('ai-math-document-editor-v1');
    editor.value='Начальный текст и ручные правки.'; editor.dispatchEvent(new Event('input'));
    const first=editor.value;
    $('draft-batch-open').click(); await wait(()=>$('draft-queue').children.length===2);
    $('draft-queue').firstElementChild.querySelectorAll('button')[1].click();
    if(!$('draft-queue').firstElementChild.textContent.startsWith('export-second.wav'))throw Error('Queue reordering failed');
    $('draft-queue').firstElementChild.querySelector('button').disabled=true;
    $('draft-queue').lastElementChild.querySelector('button').click();
    $('draft-batch-start').click();
    await wait(()=>$('draft-status').textContent.includes('Очередь завершена'));
    if(!editor.value.startsWith(first) || !editor.value.includes('Hello'))throw Error('Queue did not append to draft');
    const appended=editor.value;
    $('draft-output-mode').value='files'; $('draft-output-limit').value='5000'; $('draft-folder').click(); await wait(()=>$('draft-folder-name').textContent.includes('batch-txt'));
    $('draft-batch-open').click(); await wait(()=>$('draft-queue').children.length===4); $('draft-batch-start').click();
    await wait(()=>$('draft-batch-start').disabled); await wait(()=>!$('draft-batch-open').disabled);
    if(!$('draft-status').textContent.includes('Очередь завершена') || editor.value!==appended)throw Error('Direct TXT mode altered draft or failed');
    const large=('Сохранить буквально 😀 \\[X_1=Y^2\\]\\n').repeat(450); editor.value=large; editor.dispatchEvent(new Event('input'));
    $('draft-output-mode').value='draft'; $('draft-output-limit').value='5000';
    $('draft-batch-open').click(); await wait(()=>$('draft-queue').children.length===6); $('draft-batch-start').click();
    await wait(()=>$('draft-batch-open').disabled); await wait(()=>!$('draft-batch-open').disabled);
    if(!$('draft-status').textContent.includes('Очередь завершена') || editor.value.startsWith(large) || !editor.value.includes('Hello'))throw Error('Draft rollover failed');
    if(localStorage.getItem('ai-math-document-editor-v1')!==originalArticle)throw Error('Batch changed main article');
    $('draft-batch-open').click(); await wait(()=>$('draft-queue').children.length===8); const beforeCancel=editor.value; $('draft-batch-start').click(); await new Promise(r=>setTimeout(r,80)); $('draft-cancel').click(); await wait(()=>!$('draft-batch-open').disabled,15000);
    if(editor.value!==beforeCancel || $('draft-queue').lastElementChild.dataset.state==='done')throw Error('Cancel lost text or processed following file');
    $('draft-queue').lastElementChild.querySelectorAll('button')[2].click(); $('draft-queue').lastElementChild.querySelectorAll('button')[2].click();
    $('draft-output-mode').value='files'; $('draft-output-limit').value='10000';
    for(let i=0;i<5;i++){const count=$('draft-queue').children.length; $('draft-batch-open').click(); await wait(()=>$('draft-queue').children.length===count+2);}
    $('draft-batch-start').click(); await wait(()=>$('draft-batch-open').disabled); await wait(()=>!$('draft-batch-open').disabled);
    if(!$('draft-status').textContent.includes('Очередь завершена') || editor.value!==beforeCancel)throw Error('Ten-item queue failed');
    return {appended,directModePreservedDraft:true,large,rollover:true,cancelPreservedText:true,articleUnchanged:true,tenItemQueue:true};
  })()`);
  const folder=path.join(output,'batch-txt'), files=(await fs.readdir(folder)).filter(f=>f.endsWith('.txt')).sort();
  const draftParts=files.filter(f=>f.startsWith('Черновик-'));
  assert(draftParts.length>=3);
  assert.equal((await Promise.all(draftParts.map(f=>fs.readFile(path.join(folder,f),'utf8')))).join(''),result.large);
  assert(files.some(f=>f.startsWith('export-')) && files.some(f=>f.startsWith('export-second-')));
  assert.equal(files.filter(f=>f.startsWith('export')).length,12);
  await fs.rename(folder,folder+'-completed');
  try {
    const preserved=await win.webContents.executeJavaScript(`(async()=>{
      const $=id=>document.getElementById(id), editor=$('draft-editor'), text='Не потерять текст и правки. '.repeat(250);
      editor.value=text; editor.dispatchEvent(new Event('input')); $('draft-output-mode').value='draft'; $('draft-output-limit').value='5000'; $('draft-batch-open').click();
      while($('draft-batch-start').disabled)await new Promise(r=>setTimeout(r,50));
      const staleRemove=$('draft-queue').lastElementChild.querySelectorAll('button')[2], count=$('draft-queue').children.length;
      $('draft-batch-start').click();
      if([...$('draft-queue').querySelectorAll('button')].some(b=>!b.disabled))throw Error('Queue not locked before initial save');
      staleRemove.onclick();
      if($('draft-queue').children.length!==count || !$('draft-batch-open').disabled)throw Error('Stale remove callback unlocked queue');
      const end=Date.now()+15000; while($('draft-batch-open').disabled){if(Date.now()>end)throw Error('Write failure timeout');await new Promise(r=>setTimeout(r,50));}
      return editor.value===text && $('draft-status').textContent.includes('не очищен');
    })()`);
    assert(preserved,'Write failure must not clear draft'); result.failedWritePreservedDraft=true; result.queueLockedDuringInitialSave=true;
  } finally {await fs.rename(folder+'-completed',folder);}
  // Fail the direct TXT save after real recognition, then retry from cached text.
  const queueCount=await win.webContents.executeJavaScript(`(async()=>{
    const $=id=>document.getElementById(id); $('draft-output-mode').value='files'; $('draft-output-limit').value='5000';
    let pending; while(pending=[...$('draft-queue').children].find(r=>r.dataset.state!=='done'))pending.querySelectorAll('button')[2].click();
    const count=$('draft-queue').children.length; $('draft-batch-open').click();
    while($('draft-queue').children.length!==count+2)await new Promise(r=>setTimeout(r,50)); return count;
  })()`);
  await fs.rename(folder,folder+'-unavailable');
  let failedText;
  try {
    failedText=await win.webContents.executeJavaScript(`(async()=>{
      const $=id=>document.getElementById(id); $('draft-batch-start').click();
      const end=Date.now()+180000;while($('draft-batch-open').disabled){if(Date.now()>end)throw Error('Direct failure timeout');await new Promise(r=>setTimeout(r,100));}
      const rows=$('draft-queue').children;
      if(rows[${queueCount}].dataset.state!=='ошибка' || rows[${queueCount+1}].dataset.state!=='ожидает' || !$('draft-status').textContent.includes('TXT не сохранён'))throw Error('Failed export marked successful or queue continued');
      return $('draft-editor').value;
    })()`);
  } finally {await fs.rename(folder+'-unavailable',folder);}
  await win.webContents.executeJavaScript(`(async()=>{
    const $=id=>document.getElementById(id); $('draft-batch-start').click();
    const end=Date.now()+180000;while($('draft-batch-open').disabled){if(Date.now()>end)throw Error('Retry timeout');await new Promise(r=>setTimeout(r,100));}
    if($('draft-editor').value!==${JSON.stringify(failedText)} || !$('draft-status').textContent.includes('Очередь завершена') || [...$('draft-queue').children].some(r=>r.dataset.state!=='done'))throw Error('Retry duplicated text or skipped failed file');
  })()`);
  const finalFiles=(await fs.readdir(folder)).filter(f=>f.endsWith('.txt'));
  assert.equal(finalFiles.length,files.length+2,'Retry saves both pending files');
  result.failedDirectSaveRetry=true;
  const report={...result,large:result.large.length,files};
  await fs.writeFile(path.join(output,'batch-report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(output,'batch.png'),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(report));
};
