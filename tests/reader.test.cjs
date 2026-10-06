'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../app.js');
const { buildQueue, wordFocus, sourceFocus, createPlayer, fromPosition, articleProjection, projectionPosition, spokenPosition } = require('../article-reader.js');
const model = core.createDocumentFromMarkdown(String.raw`# Заголовок

**Привет мир** и \(x_1=2\), hello world.

1. Первый пункт
2. Второй пункт

\[P(X)=\begin{cases}R(X), & X\neq R(X),\\[4pt]I(X), & X=R(X).\end{cases}\]

~~~text
literal $x$ _ \ **
~~~`).document;
const before = JSON.stringify(model);
const paragraph = model.blocks.find(b => b.type === 'paragraph');
const firstSegment = paragraph.segments[0];
const cursorDoc = fromPosition(model, { blockId: paragraph.id, segmentId: firstSegment.id, offset: 9 });
assert.ok(buildQueue(cursorDoc)[0].speechText.startsWith('мир'));
const firstMath = paragraph.segments.find(s => s.type === 'math');
assert.equal(buildQueue(fromPosition(model, {blockId:paragraph.id, mathId:firstMath.id}))[0].latex, firstMath.latexCurrent);
const list = model.blocks.find(b => b.type === 'list');
const item = list.items[1];
assert.ok(buildQueue(fromPosition(model, { blockId:list.id, itemId:item.id, segmentId:item.segments[0].id, offset:0 }))[0].speechText.startsWith('Второй'));
assert.equal(fromPosition(model, {blockId:'missing'}), null);
assert.equal(JSON.stringify(model), before);
const projection = articleProjection(model);
assert.ok(projection.text.includes(firstMath.latexCurrent));
const projectionCaret = projectionPosition(projection, projection.text.indexOf('Привет') + 9);
assert.equal(projectionCaret.segmentId, firstSegment.id);
assert.equal(projectionCaret.offset, 9);
const continued = buildQueue(fromPosition(model, projectionCaret))[0];
const continuedPosition = spokenPosition(continued, 0);
assert.equal(continuedPosition.offset, 7);
assert.equal(continuedPosition.segmentId, firstSegment.id);
for (const piece of buildQueue(model).filter(p => p.kind === 'text')) {
  for (const word of piece.speechText.matchAll(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)) {
    const position = spokenPosition(piece, word.index);
    const sourceRange = projection.ranges.find(r => r.segmentId === position.segmentId);
    assert.equal(projection.text.slice(sourceRange.start + position.offset, sourceRange.start + position.offset + position.length).toLowerCase(), word[0].toLowerCase());
  }
}
const queue = buildQueue(model);
const sectionDoc = core.createDocumentFromMarkdown('────────────────\n\n1. Основание и статус формулировки ---\n\nСледующий текст.').document;
const sectionBefore = JSON.stringify(sectionDoc);
const sectionQueue = buildQueue(sectionDoc);
assert.deepEqual(sectionQueue.map(p => p.speechText), ['Основание и статус формулировки', 'Следующий текст.']);
assert.equal(JSON.stringify(sectionDoc), sectionBefore);
const sectionProjection = articleProjection(sectionDoc);
const rulePosition = projectionPosition(sectionProjection, 0);
assert.equal(buildQueue(fromPosition(sectionDoc, rulePosition))[0].speechText, 'Основание и статус формулировки');
const initialsDoc = core.createDocumentFromMarkdown('Н.А. Тенетко\n\n────────────────\n\n1. Основание и статус формулировки ---\n\nПродолжение статьи.').document;
const initialsQueue = buildQueue(initialsDoc);
assert.equal(initialsQueue[0].speechText, 'Н.А. Тенетко');
assert.equal(sourceFocus(initialsQueue[0], 0).current, 'Н.А.');
assert.equal(sourceFocus(initialsQueue[0], 2).current, 'Н.А.');
assert.equal(sourceFocus(initialsQueue[0], 5).current, 'Тенетко');
assert.equal(initialsQueue[1].speechText, 'Основание и статус формулировки');
assert.ok(queue.some(p => p.lang === 'ru'));
assert.ok(queue.some(p => p.lang === 'en'));
assert.deepEqual(queue.filter(p => p.kind === 'math').map(p => p.latex), core.collectMathBlocks(model).map(p => p.latexCurrent));
assert.equal(JSON.stringify(model), before);
assert.equal(buildQueue(model, { readMath: false }).some(p => p.kind === 'math'), false);
assert.ok(buildQueue(model, { readCode: true }).length > queue.length);
assert.deepEqual(wordFocus('Раз два три четыре пять', 8), { before: 'Раз два', current: 'три', after: 'четыре пять' });
const statuses = [], utterances = [], tasks = new Map(); let seq = 0;
const player = createPlayer({ synth: { cancel() {}, pause() {}, resume() {}, speak(u) { utterances.push(u); } },
  makeUtterance: text => ({ text }), onPiece() {}, onBoundary() {}, onStatus: s => statuses.push(s),
  schedule: fn => { tasks.set(++seq, fn); return seq; }, clear: id => tasks.delete(id) });
const tick = () => { const all = [...tasks.values()]; tasks.clear(); all.forEach(fn => fn()); };
player.start(queue.slice(0, 2), { pause: 0 });
const stale = utterances[0]; player.stop(); stale.onend(); stale.onerror({ error: 'canceled' });
assert.equal(tasks.size, 0); assert.equal(player.state, 'idle');
player.start(queue.slice(0, 2), {});
player.togglePause(); utterances.at(-1).onend(); tick();
assert.equal(player.state, 'paused'); const count = utterances.length;
player.togglePause(); assert.equal(utterances.length, count + 1);
utterances.at(-1).onend(); tick(); assert.equal(player.state, 'finished');
player.start([], {}); assert.equal(statuses.at(-1), 'empty');
const fixture = process.env.TENETKO_TEST_ARTICLE || require('node:path').join(__dirname, 'fixtures', 'markdown-contract.md');
if (fs.existsSync(fixture)) {
  const source = fs.readFileSync(fixture, 'utf8');
  const doc = core.createDocumentFromMarkdown(source).document;
  const original = JSON.stringify(doc); const realQueue = buildQueue(doc);
  assert.deepEqual(realQueue.filter(p => p.kind === 'math').map(p => p.latex), core.collectMathBlocks(doc).map(p => p.latexCurrent));
  assert.equal(JSON.stringify(doc), original); assert.equal(core.roundTripDocument(doc).ok, true);
  console.log(`Article: ${realQueue.length} speech fragments; ${core.collectMathBlocks(doc).length} exact formulas unchanged.`);
}
console.log('Reader: queue, languages, code/math options, cancellation, pause/resume, word focus OK.');
