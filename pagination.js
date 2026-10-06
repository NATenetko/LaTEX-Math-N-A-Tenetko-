'use strict';

// A presentation-only paginator. Receives the completed print DOM, never the
// document model or LaTeX source. MathJax containers are indivisible leaves.
async function paginatePrintView(root) {
  await document.fonts.ready;
  root.classList.add('print-layout');
  root.classList.remove('print-paginated');
  const originals = Array.from(root.children);
  const originalText = root.textContent;
  const pending = [];
  for (const block of originals) {
    const list = block.querySelector(':scope > ul, :scope > ol');
    if (!list) { pending.push(block); continue; }
    Array.from(list.children).forEach((item, index) => {
      const wrapper = block.cloneNode(false);
      const part = list.cloneNode(false);
      if (list.tagName === 'OL') part.start = (list.start || 1) + index;
      part.append(item);
      wrapper.append(part);
      pending.push(wrapper);
    });
  }
  root.replaceChildren();
  let page;
  let content;
  const nextPage = () => {
    const carry = [];
    while (content?.lastElementChild) {
      const last = content.lastElementChild;
      const introduction = /:\s*$/.test(last.textContent) && last.getBoundingClientRect().height < 85 &&
        last.matches('.print-paragraph, .print-list');
      if (!last.matches('.print-heading, .print-hr') && !introduction) break;
      carry.unshift(last);
      last.remove();
    }
    if (content && !content.children.length) page.remove();
    page = document.createElement('section');
    page.className = 'print-page';
    content = document.createElement('div');
    content.className = 'print-page-content';
    page.append(content);
    root.append(page);
    content.append(...carry);
  };
  const fits = () => content.scrollHeight <= content.clientHeight &&
    (!content.lastElementChild || content.lastElementChild.getBoundingClientRect().bottom <=
      content.getBoundingClientRect().bottom - 2);
  nextPage();

  for (let block of pending) {
    const heading = block.classList.contains('print-heading');
    // Reserve enough room for a heading and at least two following lines.
    if (heading && content.children.length &&
        content.clientHeight - (content.lastElementChild.getBoundingClientRect().bottom -
          content.getBoundingClientRect().top) < 130) nextPage();
    content.append(block);
    if (fits()) continue;
    block.remove();

    while (block) {
      content.append(block);
      if (fits()) break;
      const leaf = block.querySelector(':scope > p, :scope > blockquote, :scope > pre, :scope > ul > li, :scope > ol > li');
      const points = leaf ? printSplitPoints(leaf) : [];
      // Keep short paragraphs and list items together. Split long ones only.
      if (content.children.length > 1) {
        const remaining = content.clientHeight - block.offsetTop + content.offsetTop;
        if (!leaf || remaining < 70 || block.getBoundingClientRect().height < 100) {
          block.remove(); nextPage(); continue;
        }
      }
      if (!points.length) {
        if (content.children.length > 1) { block.remove(); nextPage(); continue; }
        const svg = block.querySelector('.print-math.display svg');
        if (svg) {
          const rect = svg.getBoundingClientRect();
          const ratio = Math.min(1, (content.clientHeight - 30) / rect.height,
            content.clientWidth / rect.width);
          svg.style.width = `${rect.width * ratio}px`;
          svg.style.height = `${rect.height * ratio}px`;
          if (fits()) break;
        }
        throw new Error('Блок не помещается на A4. Разделите длинный блок или уменьшите формулу.');
      }

      // Binary search on word boundaries; fragments preserve formatting and
      // whole math nodes. The original detached block remains the source.
      block.remove();
      let lo = 0, hi = points.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const candidate = printFragment(block, leaf, points[mid], false);
        content.append(candidate);
        const ok = fits();
        candidate.remove();
        if (ok) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (best < 0) {
        if (content.children.length) { nextPage(); continue; }
        throw new Error('Строка не помещается на страницу A4.');
      }
      // Keep at least two lines at either side of a paragraph/code split.
      // Browser widows/orphans do not apply after explicit pagination.
      const fragmentHeight = (index, tail) => {
        const candidate = printFragment(block, leaf, points[index], tail);
        content.append(candidate);
        const target = candidate.querySelector('p, blockquote, pre, li');
        const height = target.getBoundingClientRect().height;
        const line = parseFloat(getComputedStyle(target).lineHeight);
        candidate.remove();
        return { height, line };
      };
      const tail = fragmentHeight(best, true);
      if (tail.height < tail.line * 1.9 && best > 0) {
        // Move one WHOLE line to the next page, not just enough words to
        // create a second line with a single trailing word.
        const oldHeight = fragmentHeight(best, false).height;
        let left = 0, right = best - 1, previousLine = 0;
        while (left <= right) {
          const middle = (left + right) >> 1;
          if (fragmentHeight(middle, false).height < oldHeight - .5) {
            previousLine = middle; left = middle + 1;
          } else right = middle - 1;
        }
        best = previousLine;
      }
      const head = fragmentHeight(best, false);
      if (head.height < head.line * 1.9 && content.children.length) {
        nextPage(); continue;
      }
  const first = printFragment(block, leaf, points[best], false);
      const rest = printFragment(block, leaf, points[best], true);
      content.append(first);
      block = rest;
      nextPage();
    }
  }
  if (!content.children.length && root.children.length > 1) page.remove();
  root.classList.add('print-paginated');
  // No loss/reordering/normalization even in the presentation layer.
  if (root.textContent !== originalText) {
    throw new Error('Проверка вёрстки: текст изменился при разбиении страниц.');
  }
  return root.children.length;
}

function printSplitPoints(leaf) {
  const points = [];
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Whitespace belongs to the preceding fragment, including code newlines.
      const pattern = leaf.tagName === 'PRE' ? /\n/g : /\s+/g;
      for (const match of node.textContent.matchAll(pattern)) {
        points.push({ node, offset: match.index + match[0].length });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches('.print-math, mjx-container, svg')) return;
      node.childNodes.forEach(visit);
    }
  };
  visit(leaf);
  // Exclude the endpoint: it would generate an empty trailing fragment.
  return points.filter((point) => {
    const range = document.createRange();
    range.selectNodeContents(leaf);
    range.setStart(point.node, point.offset);
    return range.toString().length > 0;
  });
}

function printFragment(block, leaf, point, tail) {
  const result = block.cloneNode(true);
  const target = result.querySelector(':scope > p, :scope > blockquote, :scope > pre, :scope > ul > li, :scope > ol > li');
  const range = document.createRange();
  range.selectNodeContents(leaf);
  if (tail) range.setStart(point.node, point.offset);
  else range.setEnd(point.node, point.offset);
  target.replaceChildren(range.cloneContents());
  if (!tail) result.classList.add('print-fragment-open');
  if (tail) {
    result.classList.add('print-continuation');
    if (target.tagName === 'LI') target.style.listStyleType = 'none';
  }
  return result;
}
