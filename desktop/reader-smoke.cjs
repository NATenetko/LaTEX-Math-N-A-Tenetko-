'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createDocumentFromMarkdown } = require('../app.js');
module.exports = async function(win, output) {
  await fs.mkdir(output, { recursive: true });
  const project = createDocumentFromMarkdown(String.raw`# Проверка чтения

Привет мир. Мы читаем статью. Hello world.

\[M_{n+2}=100M_n+45S_n^{stat}\]

Последний абзац.` + '\n\n' + Array.from({length:35}, (_,i) => `Дополнительный абзац ${i+1}. Мы проверяем прокрутку статьи.`).join('\n\n') + '\n\nДальний конец статьи.').document;
  project.metadata.title = `Reader smoke ${Date.now()}`;
  const regression = createDocumentFromMarkdown('Н.А. Тенетко\n\n────────────────\n\n1. Основание и статус формулировки ---\n\nПродолжение статьи.').document;
  regression.metadata.title = `Initials regression ${Date.now()}`;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#file-input'), dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(JSON.stringify(project))}], 'reader.json', {type:'application/json'}));
    input.files = dt.files; input.dispatchEvent(new Event('change'));
    const until = Date.now() + 15000;
    while (document.querySelector('#title-input').value !== ${JSON.stringify(project.metadata.title)}) {
      if (Date.now() > until) throw Error('Import timeout'); await new Promise(r => setTimeout(r, 20));
    }
    await MathJax.startup.promise;
    const original = localStorage.getItem('ai-math-document-editor-v1');
    const voices = speechSynthesis.getVoices().map(v => ({name:v.name, lang:v.lang, local:v.localService}));
    document.querySelector('#reader-open').click();
    if (document.querySelector('#reader-dialog').hidden || document.querySelector('#reader-dialog').tagName === 'DIALOG') throw Error('Reader tab did not open');
    // Deterministic UI test; this does not claim audible system-voice verification.
    const utterances = [];
    const native = { speak:speechSynthesis.speak, cancel:speechSynthesis.cancel, pause:speechSynthesis.pause, resume:speechSynthesis.resume };
    speechSynthesis.speak = u => utterances.push(u);
    speechSynthesis.cancel = () => {}; speechSynthesis.pause = () => {}; speechSynthesis.resume = () => {};
    document.querySelector('#reader-gap').value = '0';
    document.querySelector('#reader-start').click();
    if (!utterances.length) throw Error('No speech utterance');
    document.querySelector('#document-tab').click();
    if (!document.querySelector('#reader-dialog').hidden) throw Error('Document tab failed');
    document.querySelector('#speech-tab').click();
    if (document.querySelector('#reader-status').textContent !== 'Озвучивание') throw Error('Tab switch reset playback');
    const article = document.querySelector('#reader-article');
    if (article.readOnly || !article.value.includes('M_{n+2}')) throw Error('Article navigation caret disabled');
    const editing = new InputEvent('beforeinput', {inputType:'insertText', data:'x', cancelable:true});
    article.dispatchEvent(editing); if (!editing.defaultPrevented) throw Error('Article navigation allows edits');
    document.querySelector('#reader-pause').click();
    if (document.querySelector('#reader-pause').textContent !== 'Продолжить') throw Error('Pause failed');
    document.querySelector('#reader-pause').click();
    let boundary = false, math = false;
    for (let i = 0; i < 30 && utterances.length; i++) {
      const u = utterances.shift();
      if (u.text.includes('Привет')) { u.onboundary({charIndex:7}); boundary = document.querySelector('#reader-current').textContent === 'мир.'; }
      if (document.querySelector('#reader-current').classList.contains('reader-formula')) {
        await new Promise(r => setTimeout(r, 300)); math = !!document.querySelector('#reader-current svg'); break;
      }
      u.onend(); await new Promise(r => setTimeout(r, 10));
    }
    if (!boundary || !math) throw Error('Word focus or MathJax formula failed');
    document.querySelector('#reader-pick-position').click();
    document.querySelector('#document-tab').click();
    const segment = [...document.querySelectorAll('#editor [data-segment-id]')].find(n => n.textContent.startsWith('Привет'));
    const range = document.createRange(); range.setStart(segment.firstChild, 9); range.collapse(true);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.querySelector('#reader-open').click();
    if (document.querySelector('#reader-cursor-start').disabled) throw Error('Cursor position not remembered');
    utterances.length = 0;
    document.querySelector('#reader-cursor-start').click();
    const fromCursor = utterances.at(-1);
    if (!fromCursor.text.startsWith('мир')) throw Error('Reading started at wrong caret offset');
    // Choose a position within the reader tab, then verify moving caret and auto-scroll.
    article.dispatchEvent(new Event('pointerdown'));
    article.setSelectionRange(article.value.indexOf('Дальний'), article.value.indexOf('Дальний'));
    article.dispatchEvent(new Event('mouseup'));
    utterances.length = 0; document.querySelector('#reader-cursor-start').click();
    const fromArticle = utterances.at(-1);
    if (!fromArticle.text.startsWith('Дальний')) throw Error('Article caret start failed');
    fromArticle.onboundary({charIndex:8});
    const caret = document.querySelector('#reader-visible-caret');
    if (caret.hidden || caret.getBoundingClientRect().width < 2) throw Error('Playback caret not visible');
    const caretBefore = caret.getBoundingClientRect().left;
    fromArticle.onboundary({charIndex:14});
    if (caret.getBoundingClientRect().left === caretBefore) throw Error('Playback caret not moving');
    fromArticle.onboundary({charIndex:8});
    if (article.value.slice(article.selectionStart, article.selectionEnd) !== 'конец') throw Error('Reading caret did not follow word');
    if (article.scrollTop <= 0) throw Error('Article auto-scroll failed');
    // Exercise an intentionally wide 5-word phrase: no wraps, no horizontal overflow.
    fromCursor.onboundary({charIndex:0});
    const longText = 'Предшествующее длинноесоседнееслово электромагнитнаяпоследовательность последующее длинноесоседнееслово';
    fromCursor.text = longText;
    // UI uses the immutable piece text: import long source through normal open path below.
    document.querySelector('#reader-before').textContent = 'Предшествующее длинноесоседнееслово';
    document.querySelector('#reader-current').textContent = 'электромагнитнаяпоследовательность';
    document.querySelector('#reader-after').textContent = 'последующее длинноесоседнееслово';
    window.dispatchEvent(new Event('resize'));
    document.querySelector('#reader-stage').style.padding = '29px';
    await new Promise(r => setTimeout(r, 120));
    const focus = document.querySelector('.reader-focus');
    const singleLine = getComputedStyle(focus).flexWrap === 'nowrap' && focus.scrollWidth <= focus.clientWidth + 2;
    if (!singleLine) throw Error('Visualization wraps or overflows ' + JSON.stringify({w:focus.clientWidth,s:focus.scrollWidth,scale:focus.style.getPropertyValue('--reader-scale'),spans:[...focus.children].map(n=>({w:n.getBoundingClientRect().width,font:getComputedStyle(n).fontSize}))}));
    const stage = document.querySelector('#reader-stage');
    stage.style.width = '600px';
    await new Promise(r => setTimeout(r, 120));
    if (focus.scrollWidth > focus.clientWidth + 2) throw Error('Narrow visualization overflows');
    stage.style.width = ''; await new Promise(r => setTimeout(r, 120));
    fromArticle.onboundary({charIndex:8});
    if (document.querySelector('.reader-tabs').getBoundingClientRect().top < 0) throw Error('Tabs scrolled out of view');
    if (localStorage.getItem('ai-math-document-editor-v1') !== original) throw Error('Reader mutated project');
    document.querySelector('#reader-stop').click();
    Object.assign(speechSynthesis, native);
    // Exercise the real local speech service on a short phrase, separately from UI simulation.
    const ru = speechSynthesis.getVoices().find(v => v.lang.startsWith('ru') && v.localService);
    const nativeSpeech = await new Promise(resolve => {
      const u = new SpeechSynthesisUtterance('Основание и статус формулировки.');
      if (ru) u.voice = ru; u.lang = 'ru-RU';
      let count = 0, ended = false;
      u.onboundary = () => count++;
      const timer = setTimeout(() => { if (!ended) { speechSynthesis.cancel(); resolve({completed:false, timeout:true}); } }, 20000);
      u.onend = () => { ended = true; clearTimeout(timer); resolve({completed:true, boundaries:count, voice:ru?.name}); };
      u.onerror = e => { ended = true; clearTimeout(timer); resolve({completed:false, error:e.error}); };
      speechSynthesis.speak(u);
    });
    // Reproduce the whole sequence through the real app player, not a single isolated heading.
    const nextTransfer = new DataTransfer();
    nextTransfer.items.add(new File([${JSON.stringify(JSON.stringify(regression))}], 'initials.json', {type:'application/json'}));
    input.files = nextTransfer.files; input.dispatchEvent(new Event('change'));
    const importUntil = Date.now()+15000;
    while (document.querySelector('#title-input').value !== ${JSON.stringify(regression.metadata.title)}) {
      if (Date.now()>importUntil) throw Error('Regression import timeout'); await new Promise(r=>setTimeout(r,20));
    }
    document.querySelector('#reader-open').click();
    const observed = [];
    speechSynthesis.speak = u => {
      const record = {text:u.text, initialView:document.querySelector('#reader-current').textContent, boundaries:[], ended:false}; observed.push(record);
      const boundary = u.onboundary, end = u.onend;
      u.onboundary = e => { boundary?.(e); record.boundaries.push({index:e.charIndex, view:document.querySelector('#reader-current').textContent}); };
      u.onend = e => { record.ended=true; end?.(e); };
      native.speak.call(speechSynthesis,u);
    };
    document.querySelector('#reader-start').click();
    const deadline = Date.now()+30000;
    while (document.querySelector('#reader-status').textContent !== 'Чтение завершено') {
      if (Date.now()>deadline || document.querySelector('#reader-status').textContent.startsWith('Ошибка')) throw Error('Full real sequence failed: '+JSON.stringify(observed));
      await new Promise(r=>setTimeout(r,50));
    }
    Object.assign(speechSynthesis,native);
    if (observed.length!==3 || observed.some(r=>!r.ended)) throw Error('A fragment skipped in real sequence');
    if (observed[0].initialView!=='Н.А.' || observed[0].boundaries.some(b=>b.index<4 && b.view!=='Н.А.')) throw Error('Initials changed or flashed');
    if (observed[1].text!=='Основание и статус формулировки' || !observed[1].boundaries.length) throw Error('Heading not spoken');
    document.querySelector('.reader-options').open = true;
    return {voices, boundary, math, nativeSpeech, realSequence:observed, visibleCaret:true, movingCaret:true, cursorStart:true, articleCursor:true, follow:true, autoScroll:true, tabs:true, singleLine, documentUnchanged:true, listeningQualityVerified:false};
  })()`);
  assert.equal(result.documentUnchanged, true);
  const click = await win.webContents.executeJavaScript(`(() => {
    const a = document.querySelector('#reader-article'); a.scrollIntoView({block:'nearest'});
    const r = a.getBoundingClientRect(); return {x:Math.round(r.left+100),y:Math.round(r.top+65)};
  })()`);
  win.webContents.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...click});
  win.webContents.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, ...click});
  await new Promise(r => setTimeout(r, 100));
  const actual = await win.webContents.executeJavaScript(`(() => {
    const a = document.querySelector('#reader-article'), c = document.querySelector('#reader-visible-caret');
    return {focused:document.activeElement===a, offset:a.selectionStart, visible:!c.hidden};
  })()`);
  assert.equal(actual.focused, true, 'Real mouse click focuses article');
  assert.equal(actual.visible, true, 'Real mouse click shows caret');
  win.webContents.sendInputEvent({type:'keyDown', keyCode:'Right'});
  win.webContents.sendInputEvent({type:'keyUp', keyCode:'Right'});
  await new Promise(r => setTimeout(r, 100));
  const afterArrow = await win.webContents.executeJavaScript(`document.querySelector('#reader-article').selectionStart`);
  assert.equal(afterArrow, actual.offset+1, 'Real arrow key moves article caret');
  result.realMouseCaret = true; result.realKeyboardCaret = true;
  await fs.writeFile(path.join(output, 'reader.png'), (await win.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(output, 'reader-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
};
