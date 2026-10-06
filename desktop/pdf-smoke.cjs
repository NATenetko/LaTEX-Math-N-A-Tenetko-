'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { REQUIRED_FORMULAS, createDocumentFromMarkdown, collectMathBlocks, roundTripDocument } = require('../app.js');

module.exports = async function pdfSmoke(win, output) {
  const body = 'Текст должен равномерно заполнять страницу и сохранять порядок слов. ';
  const sections = Array.from({ length: 6 }, (_, i) => `## Раздел ${i + 1}\n\n` +
    `Начало раздела. Формула внутри **выделения \\(a_${i}^2=b_${i}\\)**.\n\n` +
    body.repeat(35) + `**Связка \\(X_${i}=Y_${i}\\) сохраняется.** ` + body.repeat(40) + '\n\n' + `\\[${REQUIRED_FORMULAS[i]}\\]\n\n` +
    Array.from({ length: 6 }, (_, j) => `${j + 1}. Пункт ${i + 1}.${j + 1}: ${body.repeat(3)}`).join('\n'));
  const fixtureIndex = process.argv.indexOf('--pdf-fixture');
  const source = fixtureIndex >= 0 ? await fs.readFile(process.argv[fixtureIndex + 1], 'utf8') : '# Проверка вёрстки A4\n\n' + sections.join('\n\n') +
    // The historical \= fixture is intentionally preserved in core regression
    // tests. For visual QA use a valid matrix equality (not a TeX accent).
    '\n\n## Многострочные формулы\n\n' + REQUIRED_FORMULAS.slice(6).map(s => `\\[${s.replace(String.raw`\=`, '=')}\\]`).join('\n\n') +
    '\n\n## Длинный код\n\n```text\n' + Array.from({ length: 110 }, (_, i) => `строка_${i + 1} = A_B + C ** $literal$`).join('\n') + '\n```\n\nКонец документа.';
  const project = createDocumentFromMarkdown(source, 'Проверка A4').document;
  project.metadata.title = `PDF smoke ${Date.now()}`;
  const before = collectMathBlocks(project).map(s => s.latexCurrent);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'fixture.mathdoc.json'), JSON.stringify(project, null, 2));
  await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#file-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(JSON.stringify(project))}], 'fixture.mathdoc.json', {type:'application/json'}));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
    const deadline = Date.now() + 60000;
    while (document.querySelector('#title-input').value !== ${JSON.stringify(project.metadata.title)} || !window.MathJax?.tex2svgPromise) {
      if (Date.now() > deadline) throw new Error('Import timeout');
      await new Promise(r => setTimeout(r, 50));
    }
    await window.MathJax.startup.promise;
  })()`);
  for (const style of ['classic', 'modern']) {
    await win.webContents.executeJavaScript(`(async () => {
    const style = document.querySelector('#pdf-style');
    document.querySelector('#reader-open')?.click();
    style.value = ${JSON.stringify(style)};
    style.dispatchEvent(new Event('change'));
    if (localStorage.getItem('ai-math-pdf-style-v1') !== style.value) throw new Error('Style preference not saved');
    const deadline = Date.now() + 60000;
    document.querySelector('#print-btn').click();
    while (document.querySelector('#print-btn').disabled) {
      if (Date.now() > deadline) throw new Error('PDF timeout');
      await new Promise(r => setTimeout(r, 100));
    }
  })()`);
  const report = JSON.parse(await fs.readFile(path.join(output, `layout-${style}-report.json`), 'utf8'));
  assert.equal(report.style, style);
  assert.equal(report.alignment, 'justify');
  assert.match(report.font, style === 'classic' ? /Times New Roman/ : /Arial/);
  assert.deepEqual(report.formulas, before, 'Printed math sources unchanged and not duplicated');
  assert.equal(report.fallbackCount, 0, 'All formulas rendered by MathJax');
  assert.equal(report.mathErrors, 0, 'No MathJax errors in the visual fixture');
  assert.ok(report.pages.length >= 5);
  report.pages.forEach(page => {
    assert.ok(page.scrollHeight <= page.height, 'Page must not overflow');
    assert.equal(page.headingsAtEnd, false, 'Heading must not be alone at bottom');
  });
  const saved = await win.webContents.executeJavaScript(`localStorage.getItem('ai-math-document-editor-v1')`);
  const after = JSON.parse(saved);
  assert.equal(after.rawSource, source, 'Original pasted text preserved exactly');
  assert.deepEqual(collectMathBlocks(after).map(s => s.latexCurrent), before);
  assert.equal(roundTripDocument(after).ok, true);
  console.log(`PDF ${style} OK: ${report.pages.length} A4 pages, ${before.length} exact formulas, justified text.`);
  }
};
