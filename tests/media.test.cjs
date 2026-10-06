'use strict';
const assert=require('node:assert/strict');
const {validate}=require('../desktop/media-export.cjs');
const {cues,drawText}=require('../media-export.js');
const {createDocumentFromMarkdown,serializeForAI}=require('../app.js');
const reader=require('../article-reader.js');
const good={kind:'video',pieces:[{text:'Привет',lang:'ru-RU'}],rate:1,pitch:1,volume:1,pause:100};
assert.equal(validate(good).timing,true);
assert.equal(validate({...good,kind:'audio'}).timing,false);
for(const change of [{kind:'screen'},{rate:NaN},{pause:-1},{pieces:[]},{pieces:[{text:'x',lang:'unsupported'}]}]) assert.throws(()=>validate({...good,...change}));
const project=createDocumentFromMarkdown(String.raw`Н.А. Тенетко

\[M_{n+2}=100M_n+45S_n^{stat}\]

Последний абзац.`).document;
const before=JSON.stringify(project), serialized=serializeForAI(project);
const queue=reader.buildQueue(project,{readMath:true});
const timeline={duration:queue.length*3,segments:queue.map((p,i)=>({start:i*3,duration:3,words:[{index:0,length:3,time:0},{index:4,length:3,time:1}]}))};
const frames=cues(queue,timeline);
assert(frames.some(c=>c.piece.kind==='math'));
assert(frames.every((c,i)=>!i || c.time>=frames[i-1].time));
assert.equal(reader.sourceFocus(queue[0],0).current,'Н.А.');
assert.equal(JSON.stringify(project),before); assert.equal(serializeForAI(project),serialized);
const drawn=[]; const ctx={measureText(s){return {width:s.length*parseFloat(this.font.match(/([\d.]+)px/)[1])*0.5};},fillText:(s,x,y)=>drawn.push({s,x,y}),fillRect(){}};
drawText(ctx,{before:'первое',current:'оченьдлинноеслово'.repeat(4),after:'последнее'});
assert.equal(drawn.length,3); assert(drawn.every(d=>d.x>=0 && d.x<960 && d.y===120));
console.log('Media tests passed: validation, cues, initials, canvas fitting, exact source preservation');
