'use strict';

const PDF_STYLE_KEY = 'ai-math-pdf-style-v1';
function applyPdfStyle(root) {
  root.dataset.pdfStyle = document.querySelector('#pdf-style')?.value === 'modern' ? 'modern' : 'classic';
  // Recover paragraph boundaries in the PRINT DOM only: stable 1.3 stores
  // adjacent paragraphs together separated by two newlines. Keep all chars.
  for (const wrapper of [...root.querySelectorAll('.print-paragraph')]) {
    const leaf = wrapper.querySelector(':scope > p');
    if (!leaf) continue;
    const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
    const cuts = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest('.print-math, code, mjx-container')) continue;
      for (const match of node.textContent.matchAll(/(?:\r?\n)[\t ]*(?:\r?\n)(?:[\t ]*\r?\n)*/g)) {
        cuts.push({ node, offset: match.index + match[0].length });
      }
    }
    if (!cuts.length) continue;
    const fragment = document.createDocumentFragment();
    let previous = null;
    for (const cut of [...cuts, null]) {
      const range = document.createRange();
      range.selectNodeContents(leaf);
      if (previous) range.setStart(previous.node, previous.offset);
      if (cut) range.setEnd(cut.node, cut.offset);
      const block = wrapper.cloneNode(false);
      const paragraph = leaf.cloneNode(false);
      paragraph.append(range.cloneContents());
      block.append(paragraph);
      fragment.append(block);
      previous = cut;
    }
    wrapper.replaceWith(fragment);
  }
}
function initializePdfStyles() {
  const select = document.querySelector('#pdf-style');
  if (!select) return;
  try { select.value = localStorage.getItem(PDF_STYLE_KEY) === 'modern' ? 'modern' : 'classic'; }
  catch (_) { select.value = 'classic'; }
  select.addEventListener('change', () => {
    try { localStorage.setItem(PDF_STYLE_KEY, select.value); } catch (_) { /* Session preference still works. */ }
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializePdfStyles);
else initializePdfStyles();
