'use strict';

(() => {
  const view = window.r7View;
  if (!view) return;
  const root = view.root;
  const log = (name, fields = {}) => r7.log('info', `keys.${name}`, { session: cfg.session, ...fields });
  const active = () => !root.hidden && term.buffer.active.type === 'normal' && root.getClientRects().length > 0;
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const plain = (text) => text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n+$/, '');
  const liveSelected = () => {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode)
      ? plain(selection.toString()) : '';
  };
  // Focusing the terminal after a click can drop the page's own selection, so the text is kept
  // from the moment the mouse is released until the next click or copy.
  let held = '';
  let selectionRetained = false;
  const selected = () => liveSelected() || held;
  function retainSelection(on) {
    if (selectionRetained === on) return;
    selectionRetained = on;
    view.retainAll('selection', on);
  }
  document.addEventListener('selectionchange', () => retainSelection(!!liveSelected()));
  function clearSelected() {
    held = '';
    window.getSelection()?.removeAllRanges();
    retainSelection(false);
  }
  // One line per key name per session, never per event.
  const used = new Set();
  const firstUse = (name) => { if (!used.has(name)) { used.add(name); log('view', { key: name }); } };
  function copy(text, via) {
    r7.writeClipboard(text);
    log('copy', { via, chars: text.length });
  }

  const find = document.createElement('div');
  find.id = 'view-find';
  find.hidden = true;
  find.setAttribute('role', 'search');
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('aria-label', 'Find in work page');
  input.placeholder = 'Find';
  const count = document.createElement('span');
  count.setAttribute('aria-live', 'polite');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close find');
  find.append(input, count, close);
  root.appendChild(find);
  let matches = [], matchIndex = -1, findTimer = 0;
  const highlights = globalThis.CSS?.highlights;
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !find.contains(record.target))) queueFind();
  });

  function paintMatches() {
    highlights?.delete('r7-find');
    highlights?.delete('r7-find-current');
    if (matches.length && highlights) {
      highlights.set('r7-find', new Highlight(...matches.map((m) => m.range)));
      if (matchIndex >= 0) highlights.set('r7-find-current', new Highlight(matches[matchIndex].range));
    }
    count.textContent = input.value ? `${matchIndex + 1}/${matches.length}` : '';
  }

  function scanFind() {
    clearTimeout(findTimer);
    findTimer = 0;
    if (find.hidden) return;
    const old = matches[matchIndex];
    matches = [];
    const needle = input.value;
    const blocks = view.blocks();
    const elements = new Set(blocks.map((block) => block.el));
    const pattern = needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
    if (pattern) for (const block of blocks) {
      const nodes = [];
      let text = '';
      const walker = document.createTreeWalker(block.el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.parentElement.closest('[hidden], [aria-hidden="true"], script, style, #view-find')) return NodeFilter.FILTER_REJECT;
          // A child block belongs to its own search pass.
          for (let el = node.parentElement; el && el !== block.el; el = el.parentElement) {
            if (elements.has(el)) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        nodes.push({ node, start: text.length });
        text += node.textContent;
      }
      pattern.lastIndex = 0;
      for (let hit; (hit = pattern.exec(text));) {
        const at = hit.index;
        const start = nodes.find((n) => n.start + n.node.length > at);
        const end = nodes.find((n) => n.start + n.node.length >= at + needle.length);
        if (!start || !end) continue;
        const range = document.createRange();
        range.setStart(start.node, at - start.start);
        range.setEnd(end.node, at + needle.length - end.start);
        matches.push({ range, id: block.id, at, el: block.el });
      }
    }
    matchIndex = old ? matches.findIndex((m) => m.id === old.id && m.at === old.at) : -1;
    if (matchIndex < 0 && matches.length) matchIndex = 0;
    paintMatches();
  }

  function queueFind() {
    if (!find.hidden && !findTimer) findTimer = setTimeout(scanFind, 120);
  }

  function showMatch() {
    const match = matches[matchIndex];
    if (!match) return;
    view.scrollToBlock(match.id);
    requestAnimationFrame(() => {
      if (find.hidden || matches[matchIndex] !== match) return;
      const rect = match.range.getBoundingClientRect();
      const page = root.getBoundingClientRect();
      if (rect.height) {
        view.release('find');
        root.scrollBy({ top: rect.top - page.top - root.clientHeight / 2, behavior: 'smooth' });
      }
    });
  }

  function openFind() {
    const text = selected();
    find.hidden = false;
    if (text && !text.includes('\n')) input.value = text;
    view.retainAll('find', true);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    input.focus({ preventScroll: true });
    input.select();
    scanFind();
    showMatch();
    log('find', { action: 'open', matches: matches.length });
  }

  function closeFind() {
    observer.disconnect();
    clearTimeout(findTimer);
    findTimer = 0;
    find.hidden = true;
    matches = [];
    matchIndex = -1;
    paintMatches();
    view.retainAll('find', false);
    term.focus();
    log('find', { action: 'close' });
  }
  close.addEventListener('click', closeFind);
  input.addEventListener('input', () => { scanFind(); showMatch(); });

  let allExpanded = false;
  function expand() {
    const under = pointer.inside ? document.elementFromPoint(pointer.x, pointer.y) : null;
    const blocks = view.blocks();
    const hovered = blocks.filter((b) => b.el.contains(under)).pop();
    const targets = hovered ? [hovered] : view.records().filter((b) => ['think', 'step', 'group', 'done', 'irc', 'compaction', 'notice'].includes(b.kind));
    const on = hovered ? hovered.el.dataset.expanded !== 'true' : !allExpanded;
    if (!hovered) allExpanded = on;
    let changed = 0;
    for (const block of targets) {
      if (view.expand(block.id, on) === false) continue;
      if (block.el) block.el.dataset.expanded = String(on);
      changed++;
    }
    log('expand', { scope: hovered ? 'block' : 'all', id: hovered?.id, on, count: changed });
    queueFind();
  }

  const picked = { id: null, numbers: new Set(), at: 0 };
  let typedAt = 0, typing = false;
  const pending = [];
  function boxState() {
    const box = findBox();
    if (!box) return null;
    const buf = term.buffer.active;
    const rows = [];
    for (let y = box.top + 1; y <= box.bottom; y++) {
      rows.push((buf.getLine(buf.baseY + y)?.translateToString(true, box.left + 3) || '').replace(/\s*(─*╯|[│▕█])\s*$/, '').trimEnd());
    }
    return { box, rows, current: rows[buf.cursorY - box.top - 1] || '' };
  }
  function flushAnswers(upTo) {
    while (pending.length) {
      const answer = pending.shift();
      // A key can flush this queue from inside editHooks' own iteration.
      setTimeout(() => {
        const i = editHooks.indexOf(answer.early);
        if (i >= 0) editHooks.splice(i, 1);
      });
      typing = true;
      try { sendInput(answer.text); } finally { typing = false; }
      typedAt = performance.now();
      if (answer === upTo) break;
    }
  }
  function answerQuestion(el, id, via) {
    const number = el.dataset.question;
    if (!/^\d+$/.test(number)) return false;
    const state = boxState();
    if (!state) return false;
    if (picked.id !== id) { picked.id = id; picked.numbers.clear(); }
    picked.numbers.add(number);
    picked.at = performance.now();
    const queued = pending.length > 0;
    const newLine = queued || performance.now() - typedAt < 500 || !!state.current.trim();
    const text = `${number}: `;
    const paste = term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
    const answer = { text: queued ? `\x1b\r${paste}` : paste };
    answer.early = () => { if (!typing) flushAnswers(); return false; };
    followBottom = true;
    term.focus();
    if (newLine && !queued) sendInput('\x1b\r');
    pending.push(answer);
    editHooks.unshift(answer.early);
    const send = () => { if (pending.includes(answer)) flushAnswers(answer); };
    const fly = () => {
      if (!pending.includes(answer)) return;
      const from = el.getBoundingClientRect();
      const screen = screenEl.getBoundingClientRect();
      const box = findBox();
      if (!box || typeof motion === 'undefined' || !from.height) { send(); return; }
      motion.hop(`${number}:`, { x: (from.left - screen.left) / cellWidth(), y: (from.top - screen.top) / rowHeight() },
        { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }, getComputedStyle(root).getPropertyValue('--question').trim(), send);
    };
    if (newLine && !queued) {
      const startY = term.buffer.active.cursorY;
      let done = false;
      const go = () => { if (done) return; done = true; watch.dispose(); clearTimeout(timer); fly(); };
      const watch = term.onRender(() => { if (term.buffer.active.cursorY !== startY || term.buffer.active.cursorX <= state.box.left + 3) go(); });
      const timer = setTimeout(go, 150);
    } else fly();
    log('question', { action: 'answer', id, number, via, newLine });
    return true;
  }

  function nextQuestion(via) {
    const reply = view.blocks().filter((b) => b.kind === 'reply').pop();
    if (!reply) return false;
    const questions = [...reply.el.querySelectorAll('[data-question]')];
    if (!questions.length) return false;
    const state = boxState();
    if (!state) return false;
    if (picked.id !== reply.id || (state.rows.every((s) => !s.trim()) && !pending.length && performance.now() - picked.at > 1000)) {
      picked.id = reply.id;
      picked.numbers.clear();
    }
    const answered = new Set(state.rows.map((s) => /^\s*(\d+):/.exec(s)?.[1]).filter(Boolean));
    for (const n of picked.numbers) answered.add(n);
    const next = questions.filter((el) => !answered.has(el.dataset.question)).sort((a, b) => Number(a.dataset.question) - Number(b.dataset.question))[0];
    if (next) {
      next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      answerQuestion(next, reply.id, via);
    }
    log('question.jump', { id: reply.id, via, count: questions.length, number: next?.dataset.question || null });
    return true;
  }

  const pointer = { x: 0, y: 0, inside: false, down: null };
  let pageTip = false;
  function addressTip(ctrl) {
    const tip = document.getElementById('link-tip');
    if (!tip) return;
    const link = ctrl && pointer.inside && active()
      ? document.elementFromPoint(pointer.x, pointer.y)?.closest('a[data-address]') : null;
    const address = link && root.contains(link) ? link.dataset.address : '';
    if (!address) {
      if (pageTip) tip.classList.remove('on');
      pageTip = false;
      return;
    }
    pageTip = true;
    tip.textContent = address;
    tip.classList.add('on');
    const rect = tip.getBoundingClientRect();
    const x = Math.min(pointer.x + 14, innerWidth - rect.width - 6);
    const y = pointer.y + 20 + rect.height > innerHeight ? pointer.y - rect.height - 10 : pointer.y + 20;
    tip.style.transform = `translate(${Math.max(6, x)}px, ${Math.max(6, y)}px)`;
  }
  root.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true;
    root.classList.toggle('ctrl-held', e.ctrlKey);
    addressTip(e.ctrlKey);
  });
  root.addEventListener('pointerleave', () => { pointer.inside = false; addressTip(false); });
  root.addEventListener('scroll', () => addressTip(false), true);
  root.addEventListener('pointerdown', (e) => {
    pointer.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  window.addEventListener('pointerup', (e) => {
    if (!active() || !pointer.down || find.contains(e.target)) return;
    held = liveSelected();
    term.focus();
  });
  // A new left click starts a new selection; a right click keeps the old one for its copy.
  window.addEventListener('pointerdown', (e) => { if (e.button === 0) held = ''; }, true);
  window.addEventListener('blur', () => { root.classList.remove('ctrl-held'); pointer.inside = false; pointer.down = null; addressTip(false); });
  window.addEventListener('keyup', (e) => { root.classList.toggle('ctrl-held', e.ctrlKey); addressTip(e.ctrlKey); }, true);

  async function openPath(path, via) {
    try {
      const win = await checkPath(cleanPath(path));
      if (!win) { log('open', { via, status: 'missing' }); return; }
      r7.openPath(win);
      log('open', { via, status: 'ok' });
    } catch (error) { r7.log('error', 'keys.open', { session: cfg.session, via, error: String(error) }); }
  }
  root.addEventListener('click', (e) => {
    if (find.contains(e.target) || e.button !== 0) return;
    const down = pointer.down;
    pointer.down = null;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const target = e.target instanceof Element ? e.target : e.target.parentElement;
    const quote = target.closest('blockquote');
    const image = target.closest('img[data-path]');
    const question = target.closest('[data-question]');
    const link = target.closest('a[href], [data-path]');
    if (quote && e.ctrlKey) {
      stop(e); copy(quote.dataset.copy ?? plain(quote.innerText), 'quote');
      quote.classList.add('view-copied');
      setTimeout(() => quote.classList.remove('view-copied'), 900);
    } else if (image) {
      stop(e); openPath(image.dataset.path, 'picture');
    } else if (question) {
      stop(e);
      const block = view.blocks().find((b) => b.el.contains(question));
      answerQuestion(question, block?.id, 'click');
    } else if (link) {
      stop(e);
      if (link.dataset.path) openPath(link.dataset.path, 'path');
      else { r7.openExternal(link.getAttribute('href')); log('open', { via: 'link', status: 'ok' }); }
    }
  });

  root.addEventListener('contextmenu', (e) => {
    if (find.contains(e.target)) return;
    stop(e);
    const image = e.target.closest?.('img[data-path]');
    if (image) {
      checkPath(image.dataset.path).then((path) => {
        if (path) r7.pictureMenu({ path }, e.clientX, e.clientY);
      }).catch((error) => r7.log('error', 'keys.open', { session: cfg.session, via: 'picture-menu', error: String(error) }));
    } else if (selected()) { copy(selected(), 'selection'); clearSelected(); }
    else { term.focus(); paste(); }
  });

  // ---- scrolling ------------------------------------------------------------------
  // One eased scroller for the wheel and the keys: each input moves a target, one animation
  // frame eases the page toward it and stops when it arrives, so a new wheel tick retargets
  // instead of restarting and nothing runs while the page is still.
  const slide = { target: 0, pos: 0, seen: 0, last: 0, height: 0, frame: 0, goal: '', down: false };
  window.addEventListener('r7-view-reset', () => {
    cancelAnimationFrame(slide.frame);
    Object.assign(slide, { target: 0, pos: 0, seen: 0, last: 0, height: 0, frame: 0, goal: '', down: false });
  });
  window.addEventListener('r7-clear', () => {
    clearSelected();
    if (!find.hidden) closeFind();
    input.value = '';
    allExpanded = false;
    pointer.inside = false;
    pointer.down = null;
    root.classList.remove('ctrl-held');
    addressTip(false);
  });
  const maxTop = () => Math.max(0, root.scrollHeight - root.clientHeight);
  function slideTo(px, goal = '') {
    view.scrollDirection(px - (slide.frame ? slide.target : root.scrollTop));
    slide.down = goal === 'bottom' || (goal !== 'top' && px > (slide.frame ? slide.target : root.scrollTop));
    if (!goal && slide.down && px >= maxTop()) goal = 'bottom';
    if (!slide.frame) {
      slide.pos = slide.seen = root.scrollTop;
      slide.last = performance.now() - 16;
      slide.height = -1;
      slide.frame = requestAnimationFrame(slideStep);
    }
    slide.goal = goal;
    slide.target = Math.max(0, Math.min(maxTop(), px));
    if (goal === 'top' || slide.target < root.scrollTop - 0.5) view.release();
  }
  const slideBy = (dy) => slideTo((slide.frame ? slide.target : root.scrollTop) + dy);
  function slideStep(now) {
    slide.frame = 0;
    if (!active()) { slide.goal = ''; return; }
    const max = maxTop();
    // The page moved by itself (older blocks mounted above, or it shrank): keep the same distance to go.
    const moved = root.scrollTop - slide.seen;
    if (Math.abs(moved) > 0.5) { slide.pos += moved; slide.target += moved; }
    // Home reaches the top of what is built; arriving mounts older blocks, so it keeps going until nothing more appears.
    if (slide.goal === 'top') slide.target = slide.pos = 0;
    else if (slide.goal === 'bottom') slide.target = max;
    slide.target = Math.min(slide.target, max);
    slide.pos = Math.min(slide.pos, max);
    const dt = Math.min(50, Math.max(1, now - slide.last));
    slide.last = now;
    slide.pos += (slide.target - slide.pos) * (1 - Math.exp(-dt / Math.max(1, cfg.scrollEaseMs ?? 45)));
    if (Math.abs(slide.target - slide.pos) < 0.5) slide.pos = slide.target;
    const dpr = window.devicePixelRatio || 1;
    root.scrollTop = Math.round(slide.pos * dpr) / dpr;
    slide.seen = root.scrollTop;
    const done = slide.pos === slide.target && (slide.goal !== 'top' || root.scrollHeight === slide.height);
    slide.height = root.scrollHeight;
    if (done) {
      slide.goal = '';
      if (slide.down && maxTop() - root.scrollTop <= 2) view.follow('bottom');
    }
    else slide.frame = requestAnimationFrame(slideStep);
  }
  // Touchpad deltas are exact; they apply at once and end any ease.
  function nudge(dy) {
    view.scrollDirection(dy);
    cancelAnimationFrame(slide.frame);
    slide.frame = 0;
    slide.goal = '';
    // Scrolling up at the top of a short chat must not disable following.
    if (dy < 0 && root.scrollTop > 0) view.release('touchpad');
    root.scrollTop += dy;
    if (dy > 0 && maxTop() - root.scrollTop <= 2) view.follow('bottom');
  }

  // Alt+Up / Alt+Down: the user message before or after the top of the page, put one row below the top.
  function jumpUser(dir) {
    const row = rowHeight();
    const page = root.getBoundingClientRect().top;
    const from = (slide.frame ? slide.target : root.scrollTop) + row;
    const tops = view.records().filter((b) => b.kind === 'user').map((b) => {
      const top = view.blockTop(b.id);
      return top === null ? null : { id: b.id, top: top - page + root.scrollTop };
    }).filter(Boolean).sort((a, b) => a.top - b.top);
    const target = dir < 0 ? tops.filter((t) => t.top < from - 0.5).pop() : tops.find((t) => t.top > from + 0.5);
    if (target) view.scrollToBlock(target.id, { block: 'start', offset: row });
    else if (dir < 0) slideTo(0);
    else slideTo(Infinity, 'bottom');
  }

  // The scroll keys, or false when the key is not one.
  function scrollKey(e) {
    if (e.metaKey) return false;
    const row = rowHeight();
    const pageRows = Math.max(row, root.clientHeight - row);
    let name = '';
    if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      name = `alt+${e.key === 'ArrowUp' ? 'up' : 'down'}`;
      jumpUser(e.key === 'ArrowUp' ? -1 : 1);
    } else if (!e.altKey && !e.ctrlKey && e.key === 'PageUp') {
      name = 'pageup';
      slideBy(-pageRows);
    } else if (!e.altKey && !e.ctrlKey && e.key === 'PageDown') {
      // Page Down goes straight to the newest output and resumes autoscroll.
      name = 'pagedown';
      slideTo(Infinity, 'bottom');
    } else if (e.ctrlKey && e.shiftKey && !e.altKey) {
      const by = { ArrowUp: -3 * row, ArrowDown: 3 * row, PageUp: -pageRows, PageDown: pageRows }[e.key];
      if (by) { name = `ctrl+shift+${e.key.toLowerCase()}`; slideBy(by); }
      else if (e.key === 'Home') { name = 'ctrl+shift+home'; slideTo(0, 'top'); }
      else if (e.key === 'End') { name = 'ctrl+shift+end'; slideTo(Infinity, 'bottom'); }
    }
    if (!name) return false;
    firstUse(name);
    return true;
  }

  window.addEventListener('keydown', (e) => {
    if (!active()) return;
    root.classList.toggle('ctrl-held', e.ctrlKey);
    addressTip(e.ctrlKey);
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'f') { stop(e); openFind(); return; }
    if (!find.hidden && e.key === 'Escape') { stop(e); closeFind(); return; }
    if (!find.hidden && find.contains(e.target)) {
      if (e.key === 'Enter' && e.target === input) {
        stop(e); scanFind();
        if (matches.length) matchIndex = (matchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length;
        paintMatches(); showMatch(); log('find', { action: 'jump', index: matchIndex, matches: matches.length });
      }
      return;
    }
    if (ctrl && key === 'c' && selected()) { stop(e); copy(selected(), 'selection'); clearSelected(); return; }
    if (ctrl && !e.shiftKey && key === 'a' && (selected() || root.contains(e.target))) {
      const column = document.getElementById('view-column');
      if (column) {
        stop(e);
        retainSelection(true);
        const range = document.createRange();
        range.selectNodeContents(column);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        held = liveSelected();
        retainSelection(!!held);
        return;
      }
    }
    if (ctrl && !e.shiftKey && key === 'o') { stop(e); expand(); return; }
    if (ctrl && !e.shiftKey && e.key === 'ArrowUp' && nextQuestion('ctrl+up')) { stop(e); return; }
    if (scrollKey(e)) { stop(e); return; }
    if (root.contains(e.target) || e.target === document.body) {
      // Let xterm encode keys, modifiers and shortcuts; do not create a second encoder.
      term.focus();
      if (term.textarea && e.target !== term.textarea) {
        stop(e);
        const options = { key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, ctrlKey: e.ctrlKey, altKey: e.altKey,
          shiftKey: e.shiftKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true };
        const forwarded = new KeyboardEvent('keydown', options);
        term.textarea.dispatchEvent(forwarded);
        if (!forwarded.defaultPrevented && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          term.textarea.dispatchEvent(new KeyboardEvent('keypress', { ...options, charCode: e.key.charCodeAt(0), keyCode: e.key.charCodeAt(0), which: e.key.charCodeAt(0) }));
        }
      }
    }
  }, true);

  root.addEventListener('wheel', (e) => {
    if (e.ctrlKey || !active()) return;
    const detail = e.target.closest?.('.c-full');
    if (detail && (e.deltaX || (e.deltaY < 0 && detail.scrollTop > 0) ||
      (e.deltaY > 0 && detail.scrollTop + detail.clientHeight < detail.scrollHeight))) return;
    e.preventDefault();
    firstUse('wheel');
    const scale = e.deltaMode === 1 ? rowHeight() : e.deltaMode === 2 ? root.clientHeight : 1;
    if (e.deltaX) root.scrollLeft += e.deltaX * scale;
    if (!e.deltaY) return;
    if (view.jumping || (e.deltaY < 0 && root.scrollTop > 0)) view.release('wheel');
    // A notched wheel sends big steps in pixel mode too; touchpads send small exact ones.
    if (e.deltaMode === 0 && Math.abs(e.deltaY) < 50) nudge(e.deltaY);
    else slideBy(e.deltaY * scale * (cfg.scrollSpeed || 1));
  }, { passive: false });

  view.onChange(() => {
    if (!find.isConnected) root.appendChild(find);
    queueFind();
  });
})();
