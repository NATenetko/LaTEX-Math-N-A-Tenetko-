'use strict';

const APP_VERSION = 1;
const STORAGE_KEY = 'ai-math-document-editor-v1';
const MARKDOWN_SETTING_KEY = 'ai-math-document-editor-markdown-v1';
const TOKEN_PREFIX = '⟦MATH:';
const TOKEN_SUFFIX = '⟧';

const REQUIRED_FORMULAS = [
  String.raw`D_{10}^n`,
  String.raw`C_{10}^2=I`,
  String.raw`M_{n+2}=100M_n+45S_n^{stat}`,
  String.raw`|\mathcal P_n|=T_n=\frac{10^n}{2}=5\cdot10^{n-1}`,
  String.raw`R(C_{10}(X))=C_{10}(R(X))=C_{10}(X)`,
  String.raw`a\Vert X\Vert b`,
  String.raw`E_{\overline a,\overline b}`,
  String.raw`\operatorname{Fix}(\mathcal C_n)`,
  String.raw`P_{10}(X)=
\begin{cases}
R(X), & X\neq R(X),\\[4pt]
C_{10}(X), & X=R(X).
\end{cases}`,
  String.raw`\begin{pmatrix}
I_{n+2}\\
J_{n+2}\\
Q_{n+2}
\end{pmatrix}
\=
\begin{pmatrix}
10&0&0\\
0&10&0\\
90&90&100
\end{pmatrix}
\begin{pmatrix}
I_n\\
J_n\\
Q_n
\end{pmatrix}`
];

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    return (char === 'x' ? value : (value & 3 | 8)).toString(16);
  });
}

// Pure JavaScript SHA-256 keeps audits available even when file:// lacks SubtleCrypto.
function sha256(value) {
  const text = unescape(encodeURIComponent(String(value)));
  const maxWord = 2 ** 32;
  const words = [];
  const hash = [];
  const constants = [];
  let primeCounter = 0;
  const isComposite = {};

  for (let candidate = 2; primeCounter < 64; candidate += 1) {
    if (!isComposite[candidate]) {
      for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) isComposite[multiple] = candidate;
      if (primeCounter < 8) hash[primeCounter] = (candidate ** .5 * maxWord) | 0;
      constants[primeCounter] = (candidate ** (1 / 3) * maxWord) | 0;
      primeCounter += 1;
    }
  }

  let ascii = `${text}\x80`;
  while (ascii.length % 64 !== 56) ascii += '\x00';
  for (let i = 0; i < ascii.length; i += 1) {
    const code = ascii.charCodeAt(i);
    words[i >> 2] |= code << ((3 - i) % 4) * 8;
  }
  const bitLength = text.length * 8;
  words.push((bitLength / maxWord) | 0);
  words.push(bitLength);

  for (let blockStart = 0; blockStart < words.length; blockStart += 16) {
    const oldHash = hash.slice(0);
    const working = hash.slice(0, 8);
    const schedule = words.slice(blockStart, blockStart + 16);

    for (let round = 0; round < 64; round += 1) {
      const w15 = schedule[round - 15];
      const w2 = schedule[round - 2];
      if (round >= 16) {
        const s0 = (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3));
        const s1 = (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10));
        schedule[round] = (schedule[round - 16] + s0 + schedule[round - 7] + s1) | 0;
      }
      const e = working[4];
      const a = working[0];
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & working[5]) ^ ((~e) & working[6]);
      const temp1 = (working[7] + sigma1 + choice + constants[round] + schedule[round]) | 0;
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & working[1]) ^ (a & working[2]) ^ (working[1] & working[2]);
      const temp2 = (sigma0 + majority) | 0;
      working.pop();
      working.unshift((temp1 + temp2) | 0);
      working[4] = (working[4] + temp1) | 0;
    }
    for (let i = 0; i < 8; i += 1) hash[i] = (working[i] + oldHash[i]) | 0;
  }

  return hash.map((word) => {
    let hex = '';
    for (let byte = 3; byte >= 0; byte -= 1) hex += ((word >> (byte * 8)) & 255).toString(16).padStart(2, '0');
    return hex;
  }).join('');
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function createEmptyDocument() {
  return {
    version: APP_VERSION,
    rawSource: '',
    rawImports: [],
    blocks: [],
    metadata: { title: 'Без названия', author: '' }
  };
}

function createMathBlock(latex, display, open, close, extras = {}) {
  const exact = String(latex ?? '');
  return {
    id: uuid(),
    type: 'math',
    display: Boolean(display),
    latexOriginal: exact,
    latexCurrent: exact,
    sourceDelimiter: `${open}...${close}`,
    delimiterOpen: open,
    delimiterClose: close,
    modifiedByUser: false,
    hashOriginal: sha256(exact),
    latexSourceMissing: false,
    ...extras
  };
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function atLineStart(source, index) {
  if (index === 0) return true;
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return source.slice(lineStart, index).trim() === '';
}

/**
 * Finite-state scanner. Formula payloads are copied with slice(), never decoded,
 * normalized, trimmed, or passed through Markdown/HTML conversion.
 */
function protectPlainSource(source) {
  const input = String(source ?? '');
  const formulas = [];
  let protectedSource = '';
  let state = 'TEXT';
  let codeFence = '';
  let index = 0;

  while (index < input.length) {
    if (state === 'CODE_BLOCK') {
      if (atLineStart(input, index) && input.startsWith(codeFence, index)) {
        protectedSource += codeFence;
        index += codeFence.length;
        state = 'TEXT';
        codeFence = '';
      } else {
        protectedSource += input[index];
        index += 1;
      }
      continue;
    }

    if (atLineStart(input, index) && (input.startsWith('```', index) || input.startsWith('~~~', index))) {
      codeFence = input.startsWith('```', index) ? '```' : '~~~';
      protectedSource += codeFence;
      index += codeFence.length;
      state = 'CODE_BLOCK';
      continue;
    }

    const recoveredRange = findBareDisplayRange(input, index);
    if (recoveredRange) {
      const recoveredLatex = input.slice(recoveredRange.contentStart, recoveredRange.contentEnd);
      const block = createMathBlock(
        recoveredLatex,
        true,
        '[',
        ']',
        {
          recoveredBareDelimiter: true,
          sourceDamageSuspected: /^\s*=+\s*$/m.test(recoveredLatex) || /^\s*#\s+/m.test(recoveredLatex)
        }
      );
      formulas.push(block);
      protectedSource += `${TOKEN_PREFIX}${block.id}${TOKEN_SUFFIX}`;
      index = recoveredRange.afterClose;
      continue;
    }

    const delimiter = detectOpeningDelimiter(input, index);
    if (!delimiter) {
      protectedSource += input[index];
      index += 1;
      continue;
    }

    state = delimiter.display ? 'DISPLAY_MATH' : 'INLINE_MATH';
    const contentStart = index + delimiter.open.length;
    const contentEnd = findClosingDelimiter(input, contentStart, delimiter.close);
    if (contentEnd < 0) {
      protectedSource += input[index];
      index += 1;
      state = 'TEXT';
      continue;
    }

    const block = createMathBlock(
      input.slice(contentStart, contentEnd),
      delimiter.display,
      delimiter.open,
      delimiter.close
    );
    formulas.push(block);
    protectedSource += `${TOKEN_PREFIX}${block.id}${TOKEN_SUFFIX}`;
    index = contentEnd + delimiter.close.length;
    state = 'TEXT';
  }

  return { protectedSource, formulas };
}

function standaloneLineMarkerAt(source, index, marker) {
  if (!source.startsWith(marker, index)) return false;
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const nextBreak = source.indexOf('\n', index);
  const lineEnd = nextBreak < 0 ? source.length : nextBreak;
  return source.slice(lineStart, lineEnd).trim() === marker;
}

// Recovery for clipboard text where a renderer has stripped the backslashes
// from display delimiters. It is intentionally limited to markers that occupy
// whole lines, so ordinary square brackets in prose are never treated as math.
function findBareDisplayRange(source, index) {
  if (source[index] !== '[' || !standaloneLineMarkerAt(source, index, '[')) return null;
  const openingLineEnd = source.indexOf('\n', index);
  if (openingLineEnd < 0) return null;
  let lineStart = openingLineEnd + 1;
  while (lineStart <= source.length) {
    const lineEndCandidate = source.indexOf('\n', lineStart);
    const lineEnd = lineEndCandidate < 0 ? source.length : lineEndCandidate;
    const line = source.slice(lineStart, lineEnd);
    if (line.trim() === ']') {
      const closeOffset = line.indexOf(']');
      return {
        contentStart: openingLineEnd + 1,
        contentEnd: lineStart,
        afterClose: lineStart + closeOffset + 1
      };
    }
    if (lineEndCandidate < 0) break;
    lineStart = lineEndCandidate + 1;
  }
  return null;
}

function detectOpeningDelimiter(source, index) {
  // Some AI clipboard implementations expose already escaped Markdown source,
  // so the plain representation literally contains two backslashes.
  if (source.startsWith('\\\\[', index) && !isEscaped(source, index)) return { open: '\\\\[', close: '\\\\]', display: true };
  if (source.startsWith('\\\\(', index) && !isEscaped(source, index)) return { open: '\\\\(', close: '\\\\)', display: false };
  if (source.startsWith('\\[', index) && !isEscaped(source, index)) return { open: '\\[', close: '\\]', display: true };
  if (source.startsWith('\\(', index) && !isEscaped(source, index)) return { open: '\\(', close: '\\)', display: false };
  if (source.startsWith('$$', index) && !isEscaped(source, index)) return { open: '$$', close: '$$', display: true };
  if (source[index] === '$' && !isEscaped(source, index)) return { open: '$', close: '$', display: false };
  return null;
}

function findClosingDelimiter(source, from, close) {
  for (let index = from; index < source.length; index += 1) {
    if (source.startsWith(close, index) && !isEscaped(source, index)) return index;
  }
  return -1;
}

function tokenFor(block) {
  return `${TOKEN_PREFIX}${block.id}${TOKEN_SUFFIX}`;
}

function splitProtectedTextLiteral(value, mathMap) {
  const segments = [];
  const source = String(value ?? '');
  let cursor = 0;

  while (cursor < source.length) {
    const tokenStart = source.indexOf(TOKEN_PREFIX, cursor);
    if (tokenStart < 0) {
      appendTextSegment(segments, source.slice(cursor));
      break;
    }
    if (tokenStart > cursor) appendTextSegment(segments, source.slice(cursor, tokenStart));
    const idEnd = source.indexOf(TOKEN_SUFFIX, tokenStart + TOKEN_PREFIX.length);
    if (idEnd < 0) {
      appendTextSegment(segments, source.slice(tokenStart));
      break;
    }
    const id = source.slice(tokenStart + TOKEN_PREFIX.length, idEnd);
    const math = mathMap.get(id);
    if (math) segments.push(math);
    else appendTextSegment(segments, source.slice(tokenStart, idEnd + TOKEN_SUFFIX.length));
    cursor = idEnd + TOKEN_SUFFIX.length;
  }

  if (!segments.length) segments.push(createTextSegment(''));
  return segments;
}

function createTextSegment(text, bold = false, italic = false, code = false) {
  return {
    id: uuid(),
    type: 'text',
    text: String(text ?? ''),
    bold: Boolean(bold),
    italic: Boolean(italic),
    code: Boolean(code)
  };
}

function appendTextSegment(target, text, styles = {}) {
  if (!text) return;
  const bold = Boolean(styles.bold);
  const italic = Boolean(styles.italic);
  const code = Boolean(styles.code);
  const previous = target[target.length - 1];
  if (previous?.type === 'text' && previous.bold === bold && previous.italic === italic && previous.code === code) {
    previous.text += text;
    return;
  }
  target.push(createTextSegment(text, bold, italic, code));
}

function protectedMathTokenAt(source, index, mathMap) {
  if (!source.startsWith(TOKEN_PREFIX, index)) return null;
  const idEnd = source.indexOf(TOKEN_SUFFIX, index + TOKEN_PREFIX.length);
  if (idEnd < 0) return null;
  const id = source.slice(index + TOKEN_PREFIX.length, idEnd);
  return {
    end: idEnd + TOKEN_SUFFIX.length,
    raw: source.slice(index, idEnd + TOKEN_SUFFIX.length),
    math: mathMap.get(id) || null
  };
}

function markerCanOpen(source, index, marker) {
  const next = source[index + marker.length];
  return Boolean(next && !/\s/.test(next));
}

function markerCanClose(source, index) {
  const previous = source[index - 1];
  return Boolean(previous && !/\s/.test(previous));
}

function hasClosingInlineMarker(source, from, marker) {
  let cursor = source.indexOf(marker, from);
  while (cursor >= 0) {
    if (markerCanClose(source, cursor)) return true;
    cursor = source.indexOf(marker, cursor + marker.length);
  }
  return false;
}

// Markdown sees UUID tokens only. It never receives latexOriginal/latexCurrent.
function splitProtectedText(value, mathMap, markdownEnabled = true) {
  if (!markdownEnabled) return splitProtectedTextLiteral(value, mathMap);

  const source = String(value ?? '');
  const segments = [];
  const styles = { bold: false, italic: false, code: false };
  let buffer = '';
  let index = 0;

  const flush = () => {
    appendTextSegment(segments, buffer, styles);
    buffer = '';
  };

  while (index < source.length) {
    const protectedToken = protectedMathTokenAt(source, index, mathMap);
    if (protectedToken) {
      flush();
      if (protectedToken.math) segments.push(protectedToken.math);
      else appendTextSegment(segments, protectedToken.raw, styles);
      index = protectedToken.end;
      continue;
    }

    if (styles.code) {
      if (source[index] === '`') {
        flush();
        styles.code = false;
      } else {
        buffer += source[index];
      }
      index += 1;
      continue;
    }

    if (source[index] === '`') {
      const closing = source.indexOf('`', index + 1);
      if (closing >= 0) {
        flush();
        styles.code = true;
        index += 1;
        continue;
      }
    }

    let marker = '';
    if (source.startsWith('***', index)) marker = '***';
    else if (source.startsWith('**', index)) marker = '**';
    else if (source[index] === '*') marker = '*';

    if (marker) {
      const closesActive = marker === '***'
        ? styles.bold && styles.italic
        : marker === '**' ? styles.bold : styles.italic;
      const mayClose = closesActive && markerCanClose(source, index);
      const mayOpen = !closesActive
        && markerCanOpen(source, index, marker)
        && hasClosingInlineMarker(source, index + marker.length, marker);
      if (mayClose || mayOpen) {
        flush();
        if (marker === '**' || marker === '***') styles.bold = !styles.bold;
        if (marker === '*' || marker === '***') styles.italic = !styles.italic;
        index += marker.length;
        continue;
      }
    }

    buffer += source[index];
    index += 1;
  }

  flush();
  if (!segments.length) segments.push(createTextSegment(''));
  return segments;
}

function parseLiteralProtectedSource(protectedSource, mathMap) {
  const lines = String(protectedSource ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const segments = splitProtectedTextLiteral(paragraphLines.join('\n'), mathMap);
    paragraphLines = [];
    const meaningful = segments.filter((segment) => segment.type === 'math' || segment.text.trim() !== '');
    if (meaningful.length === 1 && meaningful[0].type === 'math' && meaningful[0].display) blocks.push(meaningful[0]);
    else blocks.push({ id: uuid(), type: 'paragraph', segments });
  };

  for (const line of lines) {
    if (!line.trim()) flushParagraph();
    else paragraphLines.push(line);
  }
  flushParagraph();
  return mergeAdjacentParagraphs(blocks);
}

function isClosingFenceLine(line, fence) {
  const trimmed = String(line ?? '').trim();
  return trimmed.length >= fence.length && [...trimmed].every((character) => character === fence[0]);
}

function parseProtectedSource(protectedSource, formulas, options = {}) {
  const mathMap = new Map(formulas.map((formula) => [formula.id, formula]));
  const markdownEnabled = options.markdownEnabled !== false;
  if (!markdownEnabled) return parseLiteralProtectedSource(protectedSource, mathMap);

  const lines = String(protectedSource ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const raw = paragraphLines.join('\n');
    paragraphLines = [];
    const segments = splitProtectedText(raw, mathMap, true);
    const meaningful = segments.filter((segment) => segment.type === 'math' || segment.text.trim() !== '');
    if (meaningful.length === 1 && meaningful[0].type === 'math' && meaningful[0].display) {
      blocks.push(meaningful[0]);
    } else {
      blocks.push({ id: uuid(), type: 'paragraph', segments });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      flushParagraph();
      const fence = fenceMatch[1];
      const language = fenceMatch[2].trim();
      const rawLines = [line];
      const codeLines = [];
      let closed = false;
      index += 1;
      while (index < lines.length) {
        rawLines.push(lines[index]);
        if (isClosingFenceLine(lines[index], fence)) {
          closed = true;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push({
        id: uuid(),
        type: 'code',
        text: codeLines.join('\n'),
        language,
        fence,
        markdownCode: true,
        fenceClosed: closed,
        rawMarkdown: rawLines.join('\n')
      });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+([\s\S]*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ id: uuid(), type: 'heading', level: heading[1].length, segments: splitProtectedText(heading[2], mathMap, true) });
      continue;
    }

    if (/^\s*((-{3,})|(\*{3,})|(_{3,}))\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ id: uuid(), type: 'hr' });
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      index -= 1;
      blocks.push({ id: uuid(), type: 'quote', segments: splitProtectedText(quoteLines.join('\n'), mathMap, true) });
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+([\s\S]*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+([\s\S]*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const list = { id: uuid(), type: 'list', ordered: Boolean(ordered), items: [] };
      const listPattern = ordered ? /^\s*\d+[.)]\s+([\s\S]*)$/ : /^\s*[-+*]\s+([\s\S]*)$/;
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item) break;
        list.items.push({ id: uuid(), segments: splitProtectedText(item[1], mathMap, true) });
        index += 1;
      }
      index -= 1;
      blocks.push(list);
      continue;
    }

    paragraphLines.push(line);
  }
  flushParagraph();
  return mergeAdjacentParagraphs(blocks);
}

function mergeAdjacentParagraphs(blocks) {
  const merged = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous?.type === 'paragraph' && block.type === 'paragraph') {
      previous.segments.push(createTextSegment('\n\n'), ...(block.segments || []));
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function isMathCandidate(element) {
  if (!(element instanceof Element)) return false;
  return element.matches([
    'math', 'mjx-container', '.katex', '.math', '.math-inline', '.math-display',
    '[data-latex]', '[data-tex]', '[data-math]', 'script[type^="math/tex"]'
  ].join(','));
}

function exactLatexFromHtmlNode(node) {
  const directAttributes = ['data-latex', 'data-tex', 'data-math'];
  for (const name of directAttributes) {
    if (node.hasAttribute?.(name)) return node.getAttribute(name);
  }
  if (node.matches?.('script[type^="math/tex"]')) return node.textContent ?? '';
  const script = node.querySelector?.('script[type^="math/tex"]');
  if (script) return script.textContent ?? '';
  const annotation = node.matches?.('annotation[encoding="application/x-tex"]')
    ? node
    : node.querySelector?.('annotation[encoding="application/x-tex"], annotation[encoding="application/tex"]');
  if (annotation) return annotation.textContent ?? '';
  return null;
}

function protectHtmlSource(html) {
  if (!html || typeof DOMParser === 'undefined') return { protectedSource: '', formulas: [] };
  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  const formulas = [];
  const mathSelector = 'math, mjx-container, .MathJax, .katex, .math, .math-inline, .math-display, [role="math"], [data-latex], [data-tex], [data-math], [data-mathjax], script[type^="math/tex"], annotation[encoding="application/x-tex"], annotation[encoding="application/tex"]';
  const candidates = [...parsed.body.querySelectorAll(mathSelector)]
    .filter((node) => !node.parentElement?.closest(mathSelector));

  for (const node of candidates) {
    const exact = exactLatexFromHtmlNode(node);
    const display = node.matches('.math-display, mjx-container[display="true"]') || node.closest('div, p')?.children.length === 1;
    const block = exact === null
      ? createMathBlock('', display, display ? '\\[' : '\\(', display ? '\\]' : '\\)', {
          latexSourceMissing: true,
          rawHtmlMath: node.outerHTML,
          hashOriginal: sha256('')
        })
      : createMathBlock(exact, display, display ? '\\[' : '\\(', display ? '\\]' : '\\)');
    formulas.push(block);
    node.replaceWith(parsed.createTextNode(tokenFor(block)));
  }

  return { protectedSource: htmlBodyToProtectedText(parsed.body), formulas };
}

function htmlBodyToProtectedText(body) {
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const inner = [...node.childNodes].map(walk).join('');
    if (tag === 'br') return '\n';
    if (/^h[1-3]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inner}\n\n`;
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') return `${inner}\n\n`;
    if (tag === 'strong' || tag === 'b') return `**${inner}**`;
    if (tag === 'em' || tag === 'i') return `*${inner}*`;
    if (tag === 'blockquote') return inner.split('\n').map((line) => `> ${line}`).join('\n') + '\n\n';
    if (tag === 'hr') return '---\n\n';
    if (tag === 'pre') return `\`\`\`\n${node.textContent ?? ''}\n\`\`\`\n\n`;
    if (tag === 'li') return `${inner}\n`;
    if (tag === 'ul') return inner.split('\n').filter(Boolean).map((line) => `- ${line}`).join('\n') + '\n\n';
    if (tag === 'ol') return inner.split('\n').filter(Boolean).map((line, index) => `${index + 1}. ${line}`).join('\n') + '\n\n';
    return inner;
  }
  return [...body.childNodes].map(walk).join('').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function extractClipboardDocument(plain, html, options = {}) {
  const plainResult = protectPlainSource(plain);
  const htmlResult = html ? protectHtmlSource(html) : { protectedSource: '', formulas: [] };

  // Plain text is also used for the text structure whenever it contains exact
  // formula delimiters. This avoids nested clipboard <div> wrappers turning
  // one visual answer into dozens of artificial editor blocks.
  if (plainResult.formulas.length > 0 || !html) {
    return { blocks: parseProtectedSource(plainResult.protectedSource, plainResult.formulas, options), formulas: plainResult.formulas, source: 'plain' };
  }
  if (htmlResult.formulas.length > 0) {
    return { blocks: parseProtectedSource(htmlResult.protectedSource, htmlResult.formulas, options), formulas: htmlResult.formulas, source: 'html' };
  }
  return { blocks: parseProtectedSource(plainResult.protectedSource, [], options), formulas: [], source: 'plain' };
}

function createDocumentFromMarkdown(markdown, fileName = 'document.md', options = {}) {
  const exactSource = String(markdown ?? '');
  const imported = extractClipboardDocument(exactSource, '', options);
  const title = String(fileName || 'document.md')
    .replace(/\.(?:md|markdown)$/i, '')
    .trim() || 'Без названия';

  return {
    document: {
      version: APP_VERSION,
      rawSource: exactSource,
      rawImports: [{
        id: uuid(),
        plain: exactSource,
        html: '',
        source: 'markdown',
        markdownEnabled: options.markdownEnabled !== false,
        fileName: String(fileName || 'document.md'),
        timestamp: new Date().toISOString()
      }],
      blocks: imported.blocks,
      metadata: { title, author: '' }
    },
    formulas: imported.formulas
  };
}

function serializeSegments(segments) {
  let result = '';
  let bold = false;
  let italic = false;

  const closeStyles = () => {
    if (italic) result += '*';
    if (bold) result += '**';
    bold = false;
    italic = false;
  };

  const openStyles = (nextBold, nextItalic) => {
    if (nextBold) result += '**';
    if (nextItalic) result += '*';
    bold = nextBold;
    italic = nextItalic;
  };

  for (const segment of segments || []) {
    if (segment.type === 'math') {
      result += segment.latexSourceMissing && !segment.latexCurrent
        ? '[Математический объект: исходный LaTeX отсутствует]'
        : `${segment.display ? '\\[' : '\\('}${segment.latexCurrent}${segment.display ? '\\]' : '\\)'}`;
      continue;
    }

    const nextBold = Boolean(segment.bold);
    const nextItalic = Boolean(segment.italic);
    if (nextBold !== bold || nextItalic !== italic) {
      closeStyles();
      openStyles(nextBold, nextItalic);
    }
    let text = segment.text ?? '';
    if (segment.code) text = `\`${text}\``;
    result += text;
  }
  closeStyles();
  return result;
}

function serializeForAI(documentModel) {
  return (documentModel.blocks || []).map((block) => {
    if (block.type === 'math') {
      if (block.latexSourceMissing && !block.latexCurrent) return '[Математический объект: исходный LaTeX отсутствует]';
      return `${block.display ? '\\[' : '\\('}${block.latexCurrent}${block.display ? '\\]' : '\\)'}`;
    }
    if (block.type === 'heading') return `${'#'.repeat(block.level || 1)} ${serializeSegments(block.segments)}`;
    if (block.type === 'paragraph') return serializeSegments(block.segments);
    if (block.type === 'quote') return serializeSegments(block.segments).split('\n').map((line) => `> ${line}`).join('\n');
    if (block.type === 'list') return (block.items || []).map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${serializeSegments(item.segments)}`).join('\n');
    if (block.type === 'hr') return '---';
    if (block.type === 'code') {
      if (block.markdownCode) {
        if (typeof block.rawMarkdown === 'string') return block.rawMarkdown;
        const fence = block.fence || '```';
        const opening = `${fence}${block.language || ''}`;
        return `${opening}\n${block.text ?? ''}${block.fenceClosed === false ? '' : `\n${fence}`}`;
      }
      return block.text ?? '';
    }
    return '';
  }).join('\n\n');
}

function collectMathBlocks(documentModel) {
  const result = [];
  for (const block of documentModel.blocks || []) {
    if (block.type === 'math') {
      result.push(block);
      continue;
    }
    for (const segment of block.segments || []) if (segment.type === 'math') result.push(segment);
    for (const item of block.items || []) {
      for (const segment of item.segments || []) if (segment.type === 'math') result.push(segment);
    }
  }
  return result;
}

function roundTripDocument(documentModel) {
  const before = collectMathBlocks(documentModel).filter((block) => !(block.latexSourceMissing && !block.latexCurrent)).map((block) => block.latexCurrent);
  const exported = serializeForAI(documentModel);
  const parsed = protectPlainSource(exported);
  const after = parsed.formulas.map((block) => block.latexCurrent);
  return {
    ok: before.length === after.length && before.every((formula, index) => formula === after[index]),
    before,
    after,
    exported
  };
}

function runRequiredFormulaTests() {
  const failures = [];
  REQUIRED_FORMULAS.forEach((formula, index) => {
    const first = protectPlainSource(`\\[${formula}\\]`);
    const firstLatex = first.formulas[0]?.latexCurrent;
    const testDocument = { blocks: [first.formulas[0]], rawImports: [], metadata: {}, version: 1 };
    const exported = serializeForAI(testDocument);
    const second = protectPlainSource(exported);
    const secondLatex = second.formulas[0]?.latexCurrent;
    if (firstLatex !== formula || secondLatex !== formula) failures.push({ index, expected: formula, firstLatex, secondLatex });
  });
  return { ok: failures.length === 0, passed: REQUIRED_FORMULAS.length - failures.length, total: REQUIRED_FORMULAS.length, failures };
}

function validateProject(project) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.blocks)) throw new Error('Файл не похож на проект MathDoc.');
  if (Number(project.version) !== APP_VERSION) throw new Error(`Версия проекта ${project.version} пока не поддерживается.`);
  project.rawImports = Array.isArray(project.rawImports) ? project.rawImports : [];
  project.rawSource = String(project.rawSource ?? project.rawImports[0]?.plain ?? '');
  project.metadata = { title: 'Без названия', author: '', ...(project.metadata || {}) };
  rehydrateIdsAndHashes(project);
  return project;
}

function rehydrateIdsAndHashes(project) {
  const visitMath = (math) => {
    math.id ||= uuid();
    math.latexOriginal = String(math.latexOriginal ?? '');
    math.latexCurrent = String(math.latexCurrent ?? math.latexOriginal);
    math.hashOriginal ||= sha256(math.latexOriginal);
    math.modifiedByUser = Boolean(math.modifiedByUser);
  };
  for (const block of project.blocks) {
    block.id ||= uuid();
    if (block.type === 'math') visitMath(block);
    for (const segment of block.segments || []) {
      segment.id ||= uuid();
      if (segment.type === 'math') visitMath(segment);
      else segment.code = Boolean(segment.code);
    }
    for (const item of block.items || []) {
      item.id ||= uuid();
      for (const segment of item.segments || []) {
        segment.id ||= uuid();
        if (segment.type === 'math') visitMath(segment);
        else segment.code = Boolean(segment.code);
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REQUIRED_FORMULAS, sha256, protectPlainSource, parseProtectedSource,
    serializeForAI, collectMathBlocks, roundTripDocument, runRequiredFormulaTests,
    createEmptyDocument, createMathBlock, createDocumentFromMarkdown
  };
}

if (typeof document !== 'undefined') bootApplication();

function bootApplication() {
  const elements = {
    editor: document.querySelector('#editor'),
    title: document.querySelector('#title-input'),
    author: document.querySelector('#author-input'),
    formulaCount: document.querySelector('#formula-count'),
    rawCount: document.querySelector('#raw-count'),
    integrity: document.querySelector('#integrity-summary'),
    saveState: document.querySelector('#save-state'),
    fileInput: document.querySelector('#file-input'),
    formulaDialog: document.querySelector('#formula-dialog'),
    formulaForm: document.querySelector('#formula-form'),
    formulaTitle: document.querySelector('#formula-dialog-title'),
    formulaOriginal: document.querySelector('#formula-original'),
    formulaCurrent: document.querySelector('#formula-current'),
    formulaPreview: document.querySelector('#formula-preview'),
    missingSource: document.querySelector('#missing-source-note'),
    auditDialog: document.querySelector('#audit-dialog'),
    auditBody: document.querySelector('#audit-body'),
    auditBanner: document.querySelector('#audit-banner'),
    auditDocument: document.querySelector('#audit-document-result'),
    auditRoundtrip: document.querySelector('#audit-roundtrip-result'),
    auditFixtures: document.querySelector('#audit-fixtures-result'),
    pasteHint: document.querySelector('#paste-hint'),
    printView: document.querySelector('#print-view'),
    toast: document.querySelector('#toast')
  };

  const app = {
    document: loadAutosave(),
    activeText: null,
    editingMath: null,
    creatingMath: false,
    previewTimer: 0,
    toastTimer: 0,
    mathRenderGeneration: 0,
    lastImportDiagnostic: '',
    titleBeforePrint: '',
    markdownEnabled: loadMarkdownPreference()
  };

  elements.title.value = app.document.metadata.title;
  elements.author.value = app.document.metadata.author;
  elements.markdownToggle = document.querySelector('#markdown-toggle');
  elements.markdownToggle.checked = app.markdownEnabled;
  bindEvents();
  renderDocument();

  function bindEvents() {
    document.querySelector('#new-btn').addEventListener('click', newDocument);
    document.querySelector('#open-btn').addEventListener('click', () => elements.fileInput.click());
    document.querySelector('#save-btn').addEventListener('click', saveProject);
    document.querySelector('#paste-btn').addEventListener('click', readClipboardOrPrompt);
    document.querySelector('#audit-btn').addEventListener('click', showAudit);
    document.querySelector('#copy-ai-btn').addEventListener('click', copyForAI);
    document.querySelector('#copy-original-btn').addEventListener('click', copyOriginal);
    document.querySelector('#print-btn').addEventListener('click', exportPdf);
    document.querySelector('#add-text-btn').addEventListener('click', addParagraph);
    document.querySelector('#add-math-btn').addEventListener('click', addFormula);
    document.querySelector('#add-rule-btn').addEventListener('click', addRule);
    document.querySelector('#bold-btn').addEventListener('click', () => toggleTextStyle('bold'));
    document.querySelector('#italic-btn').addEventListener('click', () => toggleTextStyle('italic'));
    document.querySelector('#quote-btn').addEventListener('click', () => changeActiveBlock('quote'));
    document.querySelector('#ul-btn').addEventListener('click', () => changeActiveBlock('list', null, false));
    document.querySelector('#ol-btn').addEventListener('click', () => changeActiveBlock('list', null, true));
    document.querySelectorAll('[data-block-type]').forEach((button) => {
      button.addEventListener('click', () => changeActiveBlock(button.dataset.blockType, Number(button.dataset.level) || null));
    });
    document.querySelector('#audit-close').addEventListener('click', () => elements.auditDialog.close());
    document.querySelector('#paste-cancel').addEventListener('click', () => { elements.pasteHint.hidden = true; });

    elements.title.addEventListener('input', () => { app.document.metadata.title = elements.title.value; markChanged(); });
    elements.author.addEventListener('input', () => { app.document.metadata.author = elements.author.value; markChanged(); });
    elements.fileInput.addEventListener('change', openProject);
    elements.markdownToggle.addEventListener('change', () => {
      app.markdownEnabled = elements.markdownToggle.checked;
      try { localStorage.setItem(MARKDOWN_SETTING_KEY, app.markdownEnabled ? 'on' : 'off'); } catch (_) { /* UI state still applies. */ }
      showToast(app.markdownEnabled
        ? 'Markdown включён для новых вставок и .md-файлов'
        : 'Markdown выключен: новые вставки будут показаны буквально');
    });
    elements.formulaForm.addEventListener('submit', submitFormulaDialog);
    elements.formulaCurrent.addEventListener('input', scheduleFormulaPreview);

    document.addEventListener('paste', handlePaste);
    window.addEventListener('afterprint', () => {
      elements.printView.replaceChildren();
      elements.printView.setAttribute('aria-hidden', 'true');
      elements.saveState.textContent = 'Готово';
      if (app.titleBeforePrint) document.title = app.titleBeforePrint;
      app.titleBeforePrint = '';
    });
    window.addEventListener('keydown', (event) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'c') { event.preventDefault(); copyForAI(); }
    });
  }

  function loadAutosave() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return validateProject(JSON.parse(saved));
    } catch (_) { /* Explicit JSON save remains available. */ }
    return createEmptyDocument();
  }

  function loadMarkdownPreference() {
    try { return localStorage.getItem(MARKDOWN_SETTING_KEY) !== 'off'; }
    catch (_) { return true; }
  }

  function persistAutosave() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(app.document));
      elements.saveState.textContent = `Локально сохранено · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (_) {
      elements.saveState.textContent = 'Автосохранение недоступно — сохраните JSON';
    }
  }

  function markChanged() {
    persistAutosave();
    updateSidebar();
  }

  function newDocument() {
    if (app.document.blocks.length && !window.confirm('Создать новый документ? Текущий можно предварительно сохранить в JSON.')) return;
    app.document = createEmptyDocument();
    app.activeText = null;
    elements.title.value = app.document.metadata.title;
    elements.author.value = '';
    persistAutosave();
    renderDocument();
    showToast('Создан новый документ');
  }

  async function readClipboardOrPrompt() {
    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        let plain = '';
        let html = '';
        for (const item of items) {
          if (item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
          if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        }
        if (plain || html) {
          importClipboard(plain, html);
          return;
        }
      } catch (_) { /* The keyboard paste path provides both clipboard formats. */ }
    }
    elements.pasteHint.hidden = false;
    elements.pasteHint.focus?.();
  }

  function handlePaste(event) {
    if (elements.formulaDialog.open && event.target === elements.formulaCurrent) return;
    if (event.target?.matches?.('input, textarea')) return;
    const plain = event.clipboardData?.getData('text/plain') ?? '';
    const html = event.clipboardData?.getData('text/html') ?? '';
    if (!plain && !html) return;
    event.preventDefault();
    elements.pasteHint.hidden = true;
    importClipboard(plain, html);
  }

  function importClipboard(plain, html) {
    // This snapshot is append-only and never updated by editor operations.
    app.document.rawImports.push({
      id: uuid(),
      plain,
      html,
      markdownEnabled: app.markdownEnabled,
      timestamp: new Date().toISOString()
    });
    if (!app.document.rawSource) app.document.rawSource = plain;
    const imported = extractClipboardDocument(plain, html, { markdownEnabled: app.markdownEnabled });
    app.lastImportDiagnostic = buildImportDiagnostic(plain, html, imported);
    if (app.document.blocks.length) app.document.blocks.push(...imported.blocks);
    else app.document.blocks = imported.blocks;
    app.activeText = null;
    persistAutosave();
    renderDocument();
    const count = imported.formulas.length;
    const sourceLabel = imported.source === 'plain' ? 'plain text' : 'HTML';
    if (!count) showToast(app.lastImportDiagnostic, true);
    else showToast(`Вставка сохранена: ${count} ${plural(count, 'формула', 'формулы', 'формул')} · источник ${sourceLabel}`);
  }

  function buildImportDiagnostic(plain, html, imported) {
    if (imported.formulas.length) {
      const missing = imported.formulas.filter((formula) => formula.latexSourceMissing).length;
      const recovered = imported.formulas.filter((formula) => formula.recoveredBareDelimiter).length;
      if (recovered) {
        const suspicious = imported.formulas.filter((formula) => formula.sourceDamageSuspected).length;
        const warning = suspicious ? ` У ${suspicious} блоков уже есть признаки повреждения Markdown; они сохранены буквально.` : '';
        return `Найдено ${imported.formulas.length} ${plural(imported.formulas.length, 'формула', 'формулы', 'формул')}; у ${recovered} восстановлены потерянные delimiters [ … ].${warning}`;
      }
      return missing
        ? `${missing} математических объектов найдены в HTML, но точный TeX в буфере отсутствует.`
        : `Найдено ${imported.formulas.length} ${plural(imported.formulas.length, 'формула', 'формулы', 'формул')}.`;
    }
    const looksLikeBareLatex = /\\(?:frac|dfrac|tfrac|sqrt|begin|mathcal|operatorname|overline|Vert|sum|int)\b|[_^]\s*\{/.test(plain);
    if (looksLikeBareLatex) {
      return 'Похожий на LaTeX текст найден, но у него нет delimiters: добавьте \\(...\\), \\[...\\], $...$ или $$...$$. Автоматически угадывать границы формулы запрещено.';
    }
    if (html) return 'В буфере нет точных LaTeX delimiters и HTML не содержит доступного исходного TeX.';
    return 'В plain text не найдены delimiters \\(...\\), \\[...\\], $...$ или $$...$$.';
  }

  function renderDocument() {
    const generation = ++app.mathRenderGeneration;
    elements.editor.replaceChildren();
    if (!app.document.blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `<div class="empty-inner"><div class="empty-symbol">∑</div><h2>Вставьте математический текст</h2><p>Формулы сначала извлекаются конечным автоматом и только потом текст получает структуру. Исходный LaTeX останется отдельным защищённым объектом.</p><button class="paste-inline" type="button">Вставить из буфера</button></div>`;
      empty.querySelector('button').addEventListener('click', readClipboardOrPrompt);
      elements.editor.append(empty);
      updateSidebar();
      return;
    }

    for (const block of app.document.blocks) elements.editor.append(renderBlock(block, generation));
    updateSidebar();
  }

  function renderBlock(block, generation) {
    const wrapper = document.createElement('div');
    wrapper.className = `doc-block block-${block.type}`;
    wrapper.dataset.blockId = block.id;
    wrapper.append(createBlockTools(block));

    if (block.type === 'math') {
      wrapper.append(renderMath(block, false, generation));
      return wrapper;
    }
    if (block.type === 'hr') {
      const rule = document.createElement('hr');
      rule.className = 'rule-block';
      wrapper.append(rule);
      return wrapper;
    }
    if (block.type === 'code') {
      const code = document.createElement('pre');
      code.className = 'code-block';
      code.textContent = block.text;
      wrapper.append(code);
      return wrapper;
    }
    if (block.type === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      list.className = 'list-block';
      for (const item of block.items || []) {
        const li = document.createElement('li');
        li.append(...renderSegments(block, item.segments, generation, item.id));
        list.append(li);
      }
      wrapper.append(list);
      return wrapper;
    }

    const container = document.createElement('div');
    container.className = 'text-block';
    let content;
    if (block.type === 'heading') content = document.createElement(`h${Math.min(3, Math.max(1, block.level || 1))}`);
    else if (block.type === 'quote') {
      content = document.createElement('blockquote');
      content.className = 'quote-block';
    } else content = document.createElement('p');
    content.append(...renderSegments(block, block.segments, generation));
    container.append(content);
    wrapper.append(container);
    return wrapper;
  }

  function createBlockTools(block) {
    const tools = document.createElement('div');
    tools.className = 'block-tools';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-block';
    remove.title = 'Удалить блок';
    remove.setAttribute('aria-label', 'Удалить блок');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      app.document.blocks = app.document.blocks.filter((candidate) => candidate.id !== block.id);
      if (app.activeText?.blockId === block.id) app.activeText = null;
      markChanged();
      renderDocument();
    });
    tools.append(remove);
    return tools;
  }

  function renderSegments(block, segments = [], generation, itemId = null) {
    return segments.map((segment) => {
      if (segment.type === 'math') return renderMath(segment, true, generation);
      const span = document.createElement(segment.code ? 'code' : 'span');
      span.className = `text-segment${segment.bold ? ' is-bold' : ''}${segment.italic ? ' is-italic' : ''}${segment.code ? ' inline-code' : ''}`;
      span.contentEditable = 'true';
      span.spellcheck = true;
      span.dataset.segmentId = segment.id;
      if (!segment.text) span.dataset.placeholder = 'Введите текст…';
      span.textContent = segment.text;
      span.addEventListener('focus', () => {
        app.activeText = { blockId: block.id, segmentId: segment.id, itemId };
        syncFormatToolbar(block, segment);
      });
      span.addEventListener('input', () => {
        segment.text = span.textContent ?? '';
        markChanged();
      });
      span.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && block.type !== 'quote') {
          event.preventDefault();
          insertParagraphAfter(block.id);
        }
      });
      return span;
    });
  }

  function renderMath(mathBlock, inlineContext, generation) {
    const container = document.createElement(inlineContext && !mathBlock.display ? 'span' : 'div');
    container.className = inlineContext && !mathBlock.display ? 'math-inline' : 'math-block';
    container.contentEditable = 'false';
    container.dataset.mathId = mathBlock.id;
    container.title = 'Двойной клик — редактировать исходный LaTeX';
    container.addEventListener('dblclick', () => openFormulaEditor(mathBlock));
    if (mathBlock.latexSourceMissing && !mathBlock.latexCurrent) {
      container.classList.add('math-source-missing');
      container.textContent = 'Математический объект сохранён, но точный LaTeX в буфере отсутствовал';
      return container;
    }
    container.textContent = 'Рендеринг формулы…';
    renderMathJax(container, mathBlock.latexCurrent, mathBlock.display).then(() => {
      if (generation !== app.mathRenderGeneration && !container.isConnected) return;
    });
    return container;
  }

  async function waitForMathJax() {
    if (window.MathJax?.startup?.promise && window.MathJax?.tex2svgPromise) {
      await window.MathJax.startup.promise;
      return true;
    }
    return new Promise((resolve) => {
      let attempts = 0;
      const timer = window.setInterval(async () => {
        attempts += 1;
        if (window.MathJax?.startup?.promise && window.MathJax?.tex2svgPromise) {
          window.clearInterval(timer);
          await window.MathJax.startup.promise;
          resolve(true);
        } else if (attempts > 80) {
          window.clearInterval(timer);
          resolve(false);
        }
      }, 100);
    });
  }

  async function renderMathJax(container, latex, display) {
    const available = await waitForMathJax();
    if (!available) {
      container.classList.add('math-error');
      container.textContent = `MathJax не загрузился. Исходник сохранён:\n${latex}`;
      return false;
    }
    try {
      const node = await window.MathJax.tex2svgPromise(latex, { display });
      container.replaceChildren(node);
      return true;
    } catch (error) {
      container.classList.add('math-error');
      container.textContent = `Ошибка отображения (исходник не изменён):\n${error.message}`;
      return false;
    }
  }

  function updateSidebar() {
    const formulas = collectMathBlocks(app.document);
    const intact = formulas.filter((block) => block.hashOriginal === sha256(block.latexCurrent)).length;
    const suspicious = formulas.filter((block) => block.sourceDamageSuspected).length;
    elements.formulaCount.textContent = `${formulas.length} ${plural(formulas.length, 'формула', 'формулы', 'формул')}`;
    elements.rawCount.textContent = String(app.document.rawImports.length);
    if (!formulas.length) elements.integrity.textContent = app.lastImportDiagnostic || 'Формулы пока не найдены.';
    else if (intact === formulas.length && suspicious) elements.integrity.textContent = `Строки сохранены точно, но у ${suspicious} ${plural(suspicious, 'формулы есть', 'формул есть', 'формул есть')} признаки повреждения до вставки.`;
    else if (intact === formulas.length) elements.integrity.textContent = 'Все текущие строки совпадают с исходными.';
    else elements.integrity.textContent = `${formulas.length - intact} ${plural(formulas.length - intact, 'формула изменена', 'формулы изменены', 'формул изменены')} пользователем.`;
  }

  function findActiveContext() {
    if (!app.activeText) return null;
    const block = app.document.blocks.find((candidate) => candidate.id === app.activeText.blockId);
    if (!block) return null;
    let segments = block.segments;
    if (app.activeText.itemId) segments = block.items?.find((item) => item.id === app.activeText.itemId)?.segments;
    const segment = segments?.find((candidate) => candidate.id === app.activeText.segmentId && candidate.type === 'text');
    return segment ? { block, segment, segments } : null;
  }

  function syncFormatToolbar(block, segment) {
    document.querySelector('#bold-btn').classList.toggle('active', Boolean(segment.bold));
    document.querySelector('#italic-btn').classList.toggle('active', Boolean(segment.italic));
    document.querySelectorAll('[data-block-type]').forEach((button) => {
      const matchesType = block.type === button.dataset.blockType;
      const matchesLevel = button.dataset.blockType !== 'heading' || Number(button.dataset.level) === block.level;
      button.classList.toggle('active', matchesType && matchesLevel);
    });
  }

  function toggleTextStyle(style) {
    const context = findActiveContext();
    if (!context) return showToast('Сначала поставьте курсор в текстовый фрагмент', true);
    context.segment[style] = !context.segment[style];
    markChanged();
    renderDocument();
    focusSegment(context.segment.id);
  }

  function changeActiveBlock(type, level = null, ordered = false) {
    const context = findActiveContext();
    if (!context) return showToast('Сначала поставьте курсор в текстовый блок', true);
    const { block } = context;
    if (type === 'list') {
      if (block.type !== 'list') {
        const index = app.document.blocks.indexOf(block);
        app.document.blocks[index] = { id: block.id, type: 'list', ordered, items: [{ id: uuid(), segments: block.segments || [createTextSegment('')] }] };
      } else block.ordered = ordered;
    } else {
      if (block.type === 'list') return showToast('Для смены типа списка создайте новый абзац', true);
      block.type = type;
      if (type === 'heading') block.level = level || 1;
      else delete block.level;
    }
    markChanged();
    renderDocument();
  }

  function focusSegment(segmentId) {
    requestAnimationFrame(() => document.querySelector(`[data-segment-id="${segmentId}"]`)?.focus());
  }

  function insertParagraphAfter(blockId) {
    const index = app.document.blocks.findIndex((block) => block.id === blockId);
    const segment = createTextSegment('');
    app.document.blocks.splice(index + 1, 0, { id: uuid(), type: 'paragraph', segments: [segment] });
    markChanged();
    renderDocument();
    focusSegment(segment.id);
  }

  function addParagraph() {
    const segment = createTextSegment('');
    app.document.blocks.push({ id: uuid(), type: 'paragraph', segments: [segment] });
    markChanged();
    renderDocument();
    focusSegment(segment.id);
  }

  function addRule() {
    app.document.blocks.push({ id: uuid(), type: 'hr' });
    markChanged();
    renderDocument();
  }

  function addFormula() {
    app.creatingMath = true;
    app.editingMath = createMathBlock('', true, '\\[', '\\]');
    elements.formulaTitle.textContent = 'Новая формула';
    elements.formulaOriginal.textContent = 'Новая формула — исходник будет зафиксирован при сохранении.';
    elements.formulaCurrent.value = '';
    elements.missingSource.hidden = true;
    elements.formulaPreview.replaceChildren();
    elements.formulaDialog.showModal();
    elements.formulaCurrent.focus();
  }

  function openFormulaEditor(mathBlock) {
    app.creatingMath = false;
    app.editingMath = mathBlock;
    elements.formulaTitle.textContent = 'Редактор формулы';
    elements.formulaOriginal.textContent = mathBlock.latexSourceMissing ? '(точный источник отсутствует)' : mathBlock.latexOriginal;
    elements.formulaCurrent.value = mathBlock.latexCurrent;
    elements.missingSource.hidden = !mathBlock.latexSourceMissing;
    elements.formulaDialog.showModal();
    scheduleFormulaPreview();
    elements.formulaCurrent.focus();
  }

  function scheduleFormulaPreview() {
    window.clearTimeout(app.previewTimer);
    app.previewTimer = window.setTimeout(() => {
      elements.formulaPreview.replaceChildren();
      renderMathJax(elements.formulaPreview, elements.formulaCurrent.value, true);
    }, 180);
  }

  function submitFormulaDialog(event) {
    const submitter = event.submitter;
    if (!submitter || submitter.value === 'cancel') {
      app.editingMath = null;
      app.creatingMath = false;
      return;
    }
    event.preventDefault();
    const exactValue = elements.formulaCurrent.value;
    if (app.creatingMath) {
      const created = createMathBlock(exactValue, true, '\\[', '\\]');
      app.document.blocks.push(created);
    } else if (app.editingMath) {
      app.editingMath.latexCurrent = exactValue;
      app.editingMath.modifiedByUser = exactValue !== app.editingMath.latexOriginal;
    }
    app.editingMath = null;
    app.creatingMath = false;
    elements.formulaDialog.close();
    markChanged();
    renderDocument();
    showToast('Формула сохранена явно пользователем');
  }

  function saveProject() {
    const json = JSON.stringify(app.document, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const base = (app.document.metadata.title || 'article').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'article';
    anchor.href = url;
    anchor.download = `${base}.mathdoc.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    persistAutosave();
    showToast('Проект сохранён в JSON');
  }

  async function openProject() {
    const file = elements.fileInput.files?.[0];
    elements.fileInput.value = '';
    if (!file) return;
    try {
      const source = await file.text();
      const isMarkdown = /\.(?:md|markdown)$/i.test(file.name) || file.type === 'text/markdown';

      if (isMarkdown) {
        const imported = createDocumentFromMarkdown(source, file.name, { markdownEnabled: app.markdownEnabled });
        app.document = imported.document;
        app.lastImportDiagnostic = buildImportDiagnostic(source, '', {
          formulas: imported.formulas,
          source: 'plain'
        });
      } else {
        app.document = validateProject(JSON.parse(source));
        app.lastImportDiagnostic = '';
      }

      app.activeText = null;
      elements.title.value = app.document.metadata.title;
      elements.author.value = app.document.metadata.author;
      persistAutosave();
      renderDocument();
      if (isMarkdown) {
        const count = collectMathBlocks(app.document).length;
        showToast(`Markdown импортирован: ${count} ${plural(count, 'формула', 'формулы', 'формул')}${count ? '' : ' — проверьте delimiters'}`, !count);
      } else {
        showToast('Проект открыт без повторного parsing');
      }
    } catch (error) {
      showToast(error.message || 'Не удалось открыть файл', true);
    }
  }

  async function copyText(text, success) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    showToast(success);
  }

  function copyForAI() {
    const text = serializeForAI(app.document);
    if (!text) return showToast('Документ пуст', true);
    copyText(text, 'Документ скопирован для ИИ без преобразования LaTeX');
  }

  function copyOriginal() {
    const original = app.document.rawImports[0];
    if (!original) return showToast('Оригинальных вставок пока нет', true);
    copyText(original.plain, 'Первая plain-text вставка скопирована буквально');
  }

  async function exportPdf() {
    if (!app.document.blocks.length) return showToast('Документ пуст', true);
    elements.saveState.textContent = 'Подготовка формул к печати…';
    await buildPrintView();
    elements.saveState.textContent = 'Формулы готовы к печати';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    stripNonVisualMathLayers(elements.printView);
    app.titleBeforePrint = document.title;
    document.title = '\u200B';
    window.print();
  }

  async function buildPrintView() {
    elements.printView.replaceChildren();
    elements.printView.setAttribute('aria-hidden', 'false');
    const renderTasks = [];
    for (const block of app.document.blocks) {
      elements.printView.append(createPrintBlock(block, renderTasks));
    }
    await Promise.all(renderTasks);
    stripNonVisualMathLayers(elements.printView);
  }

  function createPrintBlock(block, renderTasks) {
    const wrapper = document.createElement('section');
    wrapper.className = `print-block print-${block.type}`;

    if (block.type === 'math') {
      wrapper.append(createPrintMath(block, renderTasks));
      return wrapper;
    }
    if (block.type === 'hr') {
      wrapper.append(document.createElement('hr'));
      return wrapper;
    }
    if (block.type === 'code') {
      const code = document.createElement('pre');
      code.textContent = block.text ?? '';
      wrapper.append(code);
      return wrapper;
    }
    if (block.type === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items || []) {
        const li = document.createElement('li');
        appendPrintSegments(li, item.segments, renderTasks);
        list.append(li);
      }
      wrapper.append(list);
      return wrapper;
    }

    let content;
    if (block.type === 'heading') content = document.createElement(`h${Math.min(3, Math.max(1, block.level || 1))}`);
    else if (block.type === 'quote') content = document.createElement('blockquote');
    else content = document.createElement('p');
    appendPrintSegments(content, block.segments, renderTasks);
    wrapper.append(content);
    return wrapper;
  }

  function appendPrintSegments(parent, segments = [], renderTasks) {
    for (const segment of segments) {
      if (segment.type === 'math') {
        parent.append(createPrintMath(segment, renderTasks));
        continue;
      }
      let node = document.createTextNode(segment.text ?? '');
      if (segment.code) {
        const code = document.createElement('code');
        code.className = 'inline-code';
        code.append(node);
        node = code;
      }
      if (segment.bold) {
        const strong = document.createElement('strong');
        strong.append(node);
        node = strong;
      }
      if (segment.italic) {
        const emphasis = document.createElement('em');
        emphasis.append(node);
        node = emphasis;
      }
      parent.append(node);
    }
  }

  function createPrintMath(mathBlock, renderTasks) {
    const container = document.createElement('span');
    container.className = `print-math ${mathBlock.display ? 'display' : 'inline'}`;
    const source = mathBlock.latexCurrent ?? '';
    container.setAttribute('role', 'math');
    container.setAttribute('aria-label', source);
    if (!source) {
      const recoveredText = textOnlyFromMathHtml(mathBlock.rawHtmlMath);
      container.textContent = recoveredText;
      return container;
    }
    renderTasks.push(renderPrintMath(container, source, mathBlock.display));
    return container;
  }

  async function renderPrintMath(container, latex, display) {
    const available = await waitForMathJax();
    if (available) {
      try {
        const node = await window.MathJax.tex2svgPromise(latex, { display });
        stripNonVisualMathLayers(node);
        node.setAttribute('aria-hidden', 'true');
        container.replaceChildren(node);
        return;
      } catch (_) { /* Exact source is printed below without an app error. */ }
    }
    container.classList.add('print-math-fallback');
    container.textContent = latex;
  }

  function stripNonVisualMathLayers(root) {
    root.querySelectorAll([
      'mjx-assistive-mml',
      '.MJX_Assistive_MathML',
      'mjx-container math'
    ].join(',')).forEach((node) => node.remove());

    // The outer .print-math keeps one aria-label with exact LaTeX. MathJax's
    // visual SVG remains aria-hidden for assistive technology, preventing a
    // second reading while preserving a single PDF accessibility source.
  }

  function textOnlyFromMathHtml(rawHtml) {
    if (!rawHtml) return '';
    try {
      const parsed = new DOMParser().parseFromString(rawHtml, 'text/html');
      return parsed.body.textContent?.replace(/\s+/g, ' ').trim() || '';
    } catch (_) {
      return '';
    }
  }

  function showAudit() {
    const formulas = collectMathBlocks(app.document);
    const roundTrip = roundTripDocument(app.document);
    const fixtures = runRequiredFormulaTests();
    elements.auditBody.replaceChildren();
    let allHashesMatch = true;

    formulas.forEach((formula, index) => {
      const currentHash = sha256(formula.latexCurrent);
      const match = formula.hashOriginal === currentHash;
      allHashesMatch &&= match;
      const row = document.createElement('tr');
      row.append(
        tableCell(String(index + 1)),
        codeCell(formula.latexSourceMissing ? '(источник отсутствует)' : formula.latexOriginal),
        codeCell(formula.latexCurrent),
        statusCell(match ? 'Нет' : 'Да', match),
        hashCell(formula.hashOriginal),
        hashCell(currentHash)
      );
      elements.auditBody.append(row);
    });

    if (!formulas.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'В документе пока нет формул.';
      row.append(cell);
      elements.auditBody.append(row);
    }

    const allOk = allHashesMatch && roundTrip.ok && fixtures.ok;
    elements.auditBanner.className = `audit-banner ${allOk ? 'ok' : 'bad'}`;
    elements.auditBanner.textContent = allOk
      ? 'LATEX_IN === LATEX_OUT. Все доступные проверки пройдены.'
      : 'Обнаружено несовпадение. Строки LaTeX показаны без нормализации — проверьте отмеченные пункты.';
    setResult(elements.auditDocument, allHashesMatch ? `${formulas.length}/${formulas.length} совпадают` : 'Есть изменения', allHashesMatch);
    setResult(elements.auditRoundtrip, roundTrip.ok ? `${roundTrip.before.length}/${roundTrip.before.length} совпадают` : 'Ошибка сравнения', roundTrip.ok);
    setResult(elements.auditFixtures, `${fixtures.passed}/${fixtures.total} пройдено`, fixtures.ok);
    elements.auditDialog.showModal();
  }

  function tableCell(value) {
    const cell = document.createElement('td');
    cell.textContent = value;
    return cell;
  }
  function codeCell(value) {
    const cell = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = value;
    cell.append(code);
    return cell;
  }
  function statusCell(value, ok) {
    const cell = tableCell(value);
    cell.className = ok ? 'changed-no' : 'changed-yes';
    return cell;
  }
  function hashCell(value) {
    const cell = tableCell(value);
    cell.className = 'hash';
    return cell;
  }
  function setResult(element, value, ok) {
    element.textContent = value;
    element.className = ok ? 'result-ok' : 'result-bad';
  }

  function showToast(message, error = false) {
    window.clearTimeout(app.toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast show${error ? ' error' : ''}`;
    app.toastTimer = window.setTimeout(() => { elements.toast.className = 'toast'; }, 3200);
  }
}

function plural(number, one, few, many) {
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
