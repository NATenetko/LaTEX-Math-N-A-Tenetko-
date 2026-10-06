'use strict';
(function () {
  const adapter = typeof module !== 'undefined' && module.exports
    ? require('./speech-adapter.js') : window.MathSpeechAdapter;

  function fromPosition(model, position) {
    if (!position) return null;
    const copy = structuredClone(model);
    const blockIndex = copy.blocks.findIndex(b => b.id === position.blockId);
    if (blockIndex < 0) return null;
    copy.blocks = copy.blocks.slice(blockIndex);
    const block = copy.blocks[0];
    if (block.type === 'math') return position.mathId === block.id ? copy : null;
    let segments = block.segments;
    if (block.type === 'list') {
      const itemIndex = block.items.findIndex(item => item.id === position.itemId);
      if (itemIndex < 0) return null;
      block.items = block.items.slice(itemIndex); segments = block.items[0].segments;
    }
    const index = segments?.findIndex(s => s.id === (position.segmentId || position.mathId)) ?? -1;
    if (index < 0) return null;
    const tail = segments.slice(index);
    if (tail[0].type !== 'math') {
      const raw = tail[0].text || '';
      let offset = Math.max(0, Math.min(raw.length, position.offset || 0));
      const isWord = c => /[\p{L}\p{N}’'-]/u.test(c || '');
      if (isWord(raw[offset])) while (offset > 0 && isWord(raw[offset - 1])) offset--;
      tail[0].text = raw.slice(offset);
      tail[0].readerOffset = (tail[0].readerOffset || 0) + offset;
    }
    if (block.type === 'list') block.items[0].segments = tail; else block.segments = tail;
    return copy;
  }

  function buildQueue(model, { readMath = true, readCode = false } = {}) {
    const queue = [];
    function text(raw, blockId, sourceParts = []) {
      // Formatting is already resolved by the editor. Do not parse Markdown or math again.
      // Bounded utterances avoid very long browser speech requests.
      const chunks = [];
      let remaining = String(raw || '');
      while (remaining) {
        let end = Math.min(350, remaining.length);
        if (end < remaining.length) {
          const boundary = remaining.slice(0, end).search(/\s+\S*$/);
          if (boundary > 175) end = boundary + 1;
        }
        chunks.push(remaining.slice(0, end)); remaining = remaining.slice(end);
      }
      let chunkOffset = 0;
      for (const chunk of chunks) {
        for (const piece of adapter.splitPlainSpeech(chunk, chunkOffset, 0)) {
          // Decorative rules are not utterances. Keep raw text and source offsets intact.
          const speechText = piece.speechText.replace(/[─━═┄┅┈┉╌╍]{2,}|[-–—_=*]{3,}/gu, ' ').replace(/\s+/g, ' ').trim();
          if (!/[\p{L}\p{N}]/u.test(speechText)) continue;
          queue.push({ kind: 'text', blockId, lang: piece.lang, speechText,
            raw: piece.raw, rawStart: piece.absStart, sourceParts });
        }
        chunkOffset += chunk.length;
      }
    }
    function math(value, blockId) {
      if (!readMath) return;
      const latex = String(value.latexCurrent ?? '');
      const speechText = value.latexSourceMissing && !latex
        ? 'Formula source is missing' : adapter.mathToEnglish(latex) || 'Mathematical formula';
      if (speechText) queue.push({ kind: 'math', blockId, mathId: value.id, latex,
        display: Boolean(value.display), lang: 'en', speechText });
    }
    function segments(values, blockId) {
      let run = '', parts = [];
      const flush = () => { text(run, blockId, parts); run = ''; parts = []; };
      for (const value of values || []) {
        if (value.type === 'math') { flush(); math(value, blockId); }
        else {
          const raw = value.text || '';
          parts.push({ segmentId: value.id, start: run.length, end: run.length + raw.length,
            offset: value.readerOffset || 0 });
          run += !value.code || readCode ? raw : ' '.repeat(raw.length);
        }
      }
      flush();
    }
    for (const block of model.blocks || []) {
      if (block.type === 'math') math(block, block.id);
      else if (block.type === 'code') { if (readCode) text(block.text, block.id); }
      else if (block.type === 'list') {
        for (const item of block.items || []) segments(item.segments, block.id);
      } else if (block.type !== 'hr') segments(block.segments, block.id);
    }
    return queue;
  }

  function wordFocus(text, charIndex) {
    const words = [...text.matchAll(/(?:[\p{L}]\.)+|[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*[.,;:!?…]*/gu)];
    const index = words.findIndex(w => charIndex < w.index + w[0].length);
    const i = index < 0 ? words.length - 1 : index;
    return { before: words.slice(Math.max(0, i - 2), i).map(w => w[0]).join(' '),
      current: words[i]?.[0] || text, after: words.slice(i + 1, i + 3).map(w => w[0]).join(' ') };
  }

  // Navigation projection only. No reparsing, serialization or mutation of the document.
  function articleProjection(model) {
    let text = ''; const ranges = [];
    function append(value, blockId, itemId) {
      const math = value.type === 'math';
      const source = math ? `\\(${value.latexCurrent || '[исходник отсутствует]'}\\)` : value.text || '';
      const start = text.length; text += source;
      ranges.push({ start, end: text.length, blockId, itemId,
        ...(math ? { mathId: value.id } : { segmentId: value.id }) });
    }
    for (const block of model.blocks || []) {
      if (block.type === 'math') append(block, block.id);
      else if (block.type === 'list') {
        (block.items || []).forEach((item, index) => {
          text += block.ordered ? `${(block.start || 1) + index}. ` : '• ';
          (item.segments || []).forEach(s => append(s, block.id, item.id)); text += '\n';
        });
      } else if (block.type === 'code') text += block.text || '';
      else if (block.type === 'hr') text += '────────────────';
      else (block.segments || []).forEach(s => append(s, block.id));
      text += '\n\n';
    }
    return { text, ranges };
  }
  function projectionPosition(projection, offset) {
    const range = projection.ranges.find(r => offset < r.end) || projection.ranges.at(-1);
    if (!range) return null;
    return { ...range, offset: Math.max(0, Math.min(range.end - range.start, offset - range.start)) };
  }
  function spokenPosition(piece, charIndex = 0) {
    if (piece.kind === 'math') return { blockId: piece.blockId, mathId: piece.mathId };
    const match = rawSpeechWord(piece, charIndex);
    const rawOffset = (piece.rawStart || 0) + (match?.index || 0);
    const part = piece.sourceParts?.find(p => rawOffset >= p.start && rawOffset < p.end);
    return part ? { blockId: piece.blockId, segmentId: part.segmentId,
      offset: part.offset + rawOffset - part.start, length: match?.[0].length || 0 } : null;
  }
  function rawSpeechWord(piece, charIndex = 0) {
    // Match spoken words to the raw copied text, allowing removed Markdown/link markers.
    const pattern = /[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu;
    const spoken = [...piece.speechText.matchAll(pattern)];
    const rawWords = [...(piece.raw || '').matchAll(pattern)];
    let rawIndex = -1, match;
    for (const word of spoken) {
      const next = rawWords.findIndex((w, i) => i > rawIndex && w[0].toLowerCase() === word[0].toLowerCase());
      if (next >= 0) { rawIndex = next; match = rawWords[next]; }
      if (charIndex < word.index + word[0].length) break;
    }
    return match;
  }
  function sourceFocus(piece, charIndex = 0) {
    return wordFocus(piece.raw || piece.speechText, rawSpeechWord(piece, charIndex)?.index || 0);
  }

  // Explicit session identity rejects late browser callbacks after stop/restart.
  function createPlayer({ synth, makeUtterance, onPiece, onBoundary, onStatus,
    schedule = setTimeout, clear = clearTimeout }) {
    let epoch = 0, timer = null, state = 'idle', queue = [], index = 0, options = {};
    let pendingAdvance = false;
    function stop() {
      epoch++; if (timer !== null) clear(timer); timer = null;
      pendingAdvance = false; state = 'idle'; synth.cancel(); onStatus('idle');
    }
    function next(session) {
      if (session !== epoch) return;
      if (state === 'paused') { pendingAdvance = true; return; }
      if (index >= queue.length) { state = 'finished'; onStatus('finished'); return; }
      const piece = queue[index];
      onPiece(piece, index, queue.length);
      const utterance = makeUtterance(piece.speechText);
      const voice = options.voices?.[piece.lang];
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || (piece.lang === 'ru' ? 'ru-RU' : 'en-US');
      utterance.rate = options.rate ?? 1; utterance.pitch = options.pitch ?? 1;
      utterance.volume = options.volume ?? 1;
      utterance.onboundary = event => {
        if (session === epoch && state === 'playing' && piece.kind === 'text') {
          onBoundary(piece, event.charIndex || 0);
        }
      };
      utterance.onend = () => {
        if (session !== epoch) return;
        index++; timer = schedule(() => { timer = null; next(session); }, options.pause ?? 250);
      };
      utterance.onerror = event => {
        if (session !== epoch) return;
        stop(); onStatus('error', event.error || 'unknown');
      };
      synth.speak(utterance);
    }
    return {
      start(values, settings) {
        stop(); queue = values; options = settings; index = 0;
        if (!queue.length) { onStatus('empty'); return; }
        state = 'playing'; onStatus(state); next(epoch);
      }, stop,
      togglePause() {
        if (state === 'playing') { state = 'paused'; synth.pause(); onStatus(state); }
        else if (state === 'paused') {
          state = 'playing'; synth.resume(); onStatus(state);
          if (pendingAdvance) { pendingAdvance = false; next(epoch); }
        }
      },
      get state() { return state; }
    };
  }
  const api = { buildQueue, wordFocus, sourceFocus, createPlayer, fromPosition, articleProjection, projectionPosition, spokenPosition };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined') return;

  window.ArticleReader = { attach };
  function attach(getSnapshot) {
    const $ = id => document.getElementById(id);
    const dialog = $('reader-dialog'), stage = $('reader-stage');
    const current = $('reader-current'), before = $('reader-before'), after = $('reader-after');
    const status = $('reader-status'), progress = $('reader-progress');
    function showTab(reading) {
      document.dispatchEvent(new CustomEvent('workspace-tab-change',{detail:reading?'speech':'document'}));
      $('audio-draft-panel').hidden = true;
      $('audio-draft-tab').setAttribute('aria-selected','false');
      $('speech-tab').hidden = false;
      dialog.hidden = !reading;
      document.body.classList.toggle('reader-mode', reading);
      if (reading) window.scrollTo(0, 0);
      $('document-tab').setAttribute('aria-selected', String(!reading));
      $('speech-tab').setAttribute('aria-selected', String(reading));
      if (reading) { refreshArticleIfChanged(); fitFocus(); }
    }
    function refreshArticleIfChanged() {
      const next = articleProjection(getSnapshot());
      if (next.text !== projection.text) { projection = next; article.value = next.text; }
    }
    const article = $('reader-article');
    const visibleCaret = $('reader-visible-caret');
    let projection = { text: '', ranges: [] };
    const mirror = document.createElement('div'); mirror.className = 'reader-caret-mirror'; dialog.append(mirror);
    function refreshArticle() {
      projection = articleProjection(getSnapshot()); article.value = projection.text;
      visibleCaret.hidden = true;
    }
    function drawCaret(offset, follow = false) {
      if (dialog.hidden) return;
      const style = getComputedStyle(article);
      Object.assign(mirror.style, { width: `${article.clientWidth}px`, font: style.font,
        lineHeight: style.lineHeight, padding: style.padding, letterSpacing: style.letterSpacing,
        tabSize: style.tabSize });
      mirror.textContent = article.value.slice(0, offset);
      const marker = document.createElement('span'); marker.textContent = article.value[offset] || '|'; mirror.append(marker);
      const top = marker.offsetTop;
      if (follow && $('reader-follow').checked && (top < article.scrollTop + 15 || top > article.scrollTop + article.clientHeight - 35)) {
        article.scrollTop = Math.max(0, top - article.clientHeight * 0.35);
      }
      const y = top - article.scrollTop;
      const x = marker.offsetLeft - article.scrollLeft;
      visibleCaret.hidden = y < 0 || y + parseFloat(style.lineHeight) > article.clientHeight || x < 0 || x > article.clientWidth;
      Object.assign(visibleCaret.style, { left: `${article.offsetLeft + article.clientLeft + x}px`,
        top: `${article.offsetTop + article.clientTop + y}px`, height: style.lineHeight });
    }
    function followPosition(position) {
      if (!position) return;
      const range = projection.ranges.find(r => position.mathId ? r.mathId === position.mathId : r.segmentId === position.segmentId);
      if (!range) return;
      const start = range.start + (position.mathId ? 0 : position.offset || 0);
      const end = position.mathId ? range.end : Math.min(range.end, start + (position.length || 0));
      article.setSelectionRange(start, end);
      // Keep a reading bookmark without moving keyboard focus away from controls.
      cursorPosition = { ...range, offset: start - range.start };
      $('reader-cursor-start').disabled = !player;
      drawCaret(start, true);
    }
    article.addEventListener('pointerdown', () => { if (['playing', 'paused'].includes(player?.state)) player.stop(); });
    article.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) player?.stop();
    });
    function pickArticlePosition() {
      cursorPosition = projectionPosition(projection, article.selectionStart);
      $('reader-cursor-start').disabled = !player || !cursorPosition;
      status.textContent = 'Место выбрано — нажмите «Читать с курсора»';
      drawCaret(article.selectionStart);
    }
    article.addEventListener('mouseup', pickArticlePosition);
    article.addEventListener('keyup', pickArticlePosition);
    article.addEventListener('beforeinput', event => event.preventDefault());
    article.addEventListener('paste', event => { event.preventDefault(); event.stopPropagation(); });
    article.addEventListener('drop', event => event.preventDefault());
    article.addEventListener('input', () => {
      const position = article.selectionStart; article.value = projection.text;
      article.setSelectionRange(position, position); drawCaret(position);
    });
    article.addEventListener('scroll', () => drawCaret(article.selectionStart));
    article.addEventListener('focus', () => drawCaret(article.selectionStart));
    new ResizeObserver(() => drawCaret(article.selectionStart)).observe(article);
    let renderEpoch = 0, cursorPosition = null;
    const focusRow = stage.querySelector('.reader-focus');
    function fitFocus() {
      if (dialog.hidden) return;
      if (current.classList.contains('reader-formula')) { focusRow.style.removeProperty('--reader-scale'); return; }
      focusRow.style.setProperty('--reader-scale', '1');
      // Actual font metrics are not perfectly linear (optical sizing/hinting).
      // Measure the final rendered line, not just a single estimated font ratio.
      let scale = 1;
      for (let attempt = 0; attempt < 8; attempt++) {
        const desired = [before, current, after].reduce((sum, span) => sum + span.getBoundingClientRect().width, 0) + 40;
        if (desired <= focusRow.clientWidth - 8) break;
        scale *= Math.max(0.01, (focusRow.clientWidth - 8) / desired) * 0.98;
        focusRow.style.setProperty('--reader-scale', String(scale));
      }
    }
    new ResizeObserver(fitFocus).observe(stage);
    function saveCursor() {
      const selection = window.getSelection();
      if (!selection?.anchorNode || !$('editor').contains(selection.anchorNode)) return;
      const element = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
      const segment = element.closest('[data-segment-id]');
      if (!segment) return;
      const range = document.createRange(); range.selectNodeContents(segment);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      const block = segment.closest('[data-block-id]');
      const modelBlock = getSnapshot().blocks.find(b => b.id === block?.dataset.blockId);
      const itemId = modelBlock?.items?.find(i => i.segments.some(s => s.id === segment.dataset.segmentId))?.id;
      cursorPosition = { blockId: block.dataset.blockId, segmentId: segment.dataset.segmentId,
        offset: range.toString().length, itemId };
      $('reader-cursor-start').disabled = !player;
    }
    document.addEventListener('selectionchange', saveCursor);
    $('editor').addEventListener('click', event => {
      const math = event.target.closest('[data-math-id]');
      if (math) {
        const block = math.closest('[data-block-id]');
        const modelBlock = getSnapshot().blocks.find(b => b.id === block.dataset.blockId);
        const itemId = modelBlock?.items?.find(i => i.segments.some(s => s.id === math.dataset.mathId))?.id;
        cursorPosition = { blockId: block.dataset.blockId, mathId: math.dataset.mathId, itemId };
        $('reader-cursor-start').disabled = !player;
      }
    });
    $('editor').addEventListener('pointerdown', () => {
      if (['playing', 'paused'].includes(player?.state)) player.stop();
    });
    const synth = window.speechSynthesis;
    let voices = [];
    function resetHighlight() {
      document.querySelectorAll('.reader-active-block').forEach(n => n.classList.remove('reader-active-block'));
    }
    function focusPiece(piece, index, total) {
      const token = ++renderEpoch;
      resetHighlight();
      const block = [...document.querySelectorAll('#editor [data-block-id]')]
        .find(node => node.dataset.blockId === piece.blockId);
      block?.classList.add('reader-active-block');
      progress.textContent = `${index + 1} / ${total} · ${piece.lang.toUpperCase()}`;
      before.textContent = ''; after.textContent = '';
      current.classList.toggle('reader-formula', piece.kind === 'math');
      // Use the same original-text word view from the first frame onward. No full-phrase flash.
      if (piece.kind === 'math') current.textContent = piece.latex || piece.speechText;
      else {
        const focus = sourceFocus(piece, 0);
        before.textContent = focus.before; current.textContent = focus.current; after.textContent = focus.after;
      }
      fitFocus();
      followPosition(spokenPosition(piece));
      if (piece.kind === 'math' && piece.latex) {
        Promise.resolve(window.MathJax?.startup?.promise).then(async () => {
          if (!window.MathJax?.tex2svgPromise) return;
          const node = await window.MathJax.tex2svgPromise(piece.latex, { display: true });
          if (token === renderEpoch) current.replaceChildren(node);
        }).catch(() => { /* Keep exact source visible if rendering fails. */ });
      }
    }
    const labels = { idle: 'Остановлено', playing: 'Озвучивание', paused: 'Пауза',
      finished: 'Чтение завершено', empty: 'Нет текста для чтения', error: 'Ошибка голоса' };
    const player = synth ? createPlayer({ synth,
      makeUtterance: text => new SpeechSynthesisUtterance(text), onPiece: focusPiece,
      onBoundary(piece, index) {
        const focus = sourceFocus(piece, index);
        before.textContent = focus.before; current.textContent = focus.current; after.textContent = focus.after;
        fitFocus();
        followPosition(spokenPosition(piece, index));
      },
      onStatus(state, error) {
        status.textContent = labels[state] + (error ? `: ${error}` : '');
        $('reader-pause').textContent = state === 'paused' ? 'Продолжить' : 'Пауза';
        $('reader-pause').disabled = !['paused', 'playing'].includes(state);
        if (['idle', 'finished', 'error', 'empty'].includes(state)) { renderEpoch++; resetHighlight(); }
      }
    }) : null;

    function loadVoices() {
      voices = synth?.getVoices() || [];
      for (const lang of ['ru', 'en']) {
        const select = $(`reader-voice-${lang}`), old = select.value;
        select.replaceChildren();
        for (const voice of voices.filter(v => v.lang.toLowerCase().startsWith(lang))) {
          const option = document.createElement('option');
          option.value = voice.voiceURI; option.textContent = `${voice.name} · ${voice.lang}${voice.localService ? ' · локальный' : ''}`;
          select.append(option);
        }
        if (!select.options.length) {
          const option = document.createElement('option'); option.value = ''; option.textContent = 'Голос системы по умолчанию'; select.append(option);
        }
        if ([...select.options].some(o => o.value === old)) select.value = old;
      }
    }
    synth?.addEventListener('voiceschanged', loadVoices);
    loadVoices();
    $('reader-open').addEventListener('click', () => {
      showTab(true); loadVoices();
      if (!player || !['playing', 'paused'].includes(player.state)) status.textContent = player ? 'Готово к чтению' : 'Системное озвучивание недоступно';
      $('reader-start').disabled = !player;
      $('reader-cursor-start').disabled = !player || !fromPosition(getSnapshot(), cursorPosition);
      fitFocus();
    });
    $('speech-tab').addEventListener('click', () => showTab(true));
    $('document-tab').addEventListener('click', () => showTab(false));
    $('audio-draft-tab').addEventListener('click',()=>{ player?.stop(); dialog.hidden=true; document.body.classList.remove('reader-mode'); $('document-tab').setAttribute('aria-selected','false'); $('speech-tab').setAttribute('aria-selected','false'); });
    function startReading(atCursor) {
      const snapshot = atCursor ? fromPosition(getSnapshot(), cursorPosition) : getSnapshot();
      if (!snapshot) { status.textContent = 'Сначала поставьте курсор в тексте статьи'; return; }
      player?.start(buildQueue(snapshot, { readMath: $('reader-math').checked, readCode: $('reader-code').checked }), {
        voices: Object.fromEntries(['ru', 'en'].map(lang => [lang, voices.find(v => v.voiceURI === $(`reader-voice-${lang}`).value)])),
        rate: Number($('reader-rate').value), pitch: Number($('reader-pitch').value),
        volume: Number($('reader-volume').value), pause: Number($('reader-gap').value)
      });
    }
    $('reader-start').addEventListener('click', () => startReading(false));
    $('reader-cursor-start').addEventListener('click', () => startReading(true));
    $('reader-pick-position').addEventListener('click', () => { player?.stop(); article.focus(); });
    $('reader-pause').addEventListener('click', () => player?.togglePause());
    $('reader-stop').addEventListener('click', () => player?.stop());
    $('reader-close').addEventListener('click', () => showTab(false));
    $('reader-fullscreen').addEventListener('click', async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.requestFullscreen(); }
      catch (_) { status.textContent = 'Полноэкранный режим недоступен'; }
    });
    window.addEventListener('article-document-changed', () => {
      cursorPosition = null; $('reader-cursor-start').disabled = true;
      refreshArticle();
      if (player && ['playing', 'paused'].includes(player.state)) {
        player.stop(); status.textContent = 'Документ изменён — запустите чтение заново';
      }
    });
    window.addEventListener('beforeunload', () => player?.stop());
    window.ArticleMediaExport?.attach({ getSnapshot, buildQueue, sourceFocus, fromPosition,
      getCursor: () => cursorPosition && structuredClone(cursorPosition), stop: () => player?.stop() });
  }
})();
