'use strict';
// Typing before a program is ready (templates with `launch.ready`), and mouse editing in
// r7Harness's input box.

(() => {
  const launchReady = cfg.launch?.ready ? new RegExp(cfg.launch.ready, 'm') : null;

  // r7Harness's box is `╭──…╮`, then `│  text  │` rows, then `╰─ text ─╯`; text starts at column 3.
  const TEXT_COL = 3;
  const rowText = (y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '';

  // Viewport rows of the input box's top and bottom border, or null.
  function findBox() {
    const buf = term.buffer.active;
    if (buf.type !== 'normal') return null;
    for (let r = term.rows - 1; r >= 0; r--) {
      if (!/^╰─.*─╯\s*$/.test(rowText(buf.viewportY + r))) continue;
      for (let t = r - 1; t >= 0; t--) {
        const text = rowText(buf.viewportY + t);
        if (/^╭/.test(text)) return { top: t, bottom: r };
        if (!/^│/.test(text)) return null;
      }
      return null;
    }
    return null;
  }

  // The viewport row where the template's `launch.ready` pattern matches, or -1.
  function readyRow() {
    const buf = term.buffer.active;
    if (!launchReady || buf.type !== 'normal') return -1;
    const rows = [];
    for (let r = 0; r < term.rows; r++) rows.push(rowText(buf.viewportY + r));
    const text = rows.join('\n');
    const m = launchReady.exec(text);
    return m ? text.slice(0, m.index).split('\n').length - 1 : -1;
  }

  // ---- type-ahead ---------------------------------------------------------------
  // A fresh session can take a few seconds before the program is ready. Meanwhile the
  // launch screen plays (launch.js) and keys type into the empty space at its top, as
  // plain text with a caret; once it's ready, the text is pasted into its input, unsent.
  // Enter does nothing until then.

  const ahead = { on: false, text: '', el: null, readyTimer: 0, giveUpTimer: 0 };

  function startTypeAhead() {
    ahead.on = true;
    ahead.el = document.createElement('div');
    ahead.el.id = 'type-ahead';
    screenEl.appendChild(ahead.el);
    launch.start();
    glide.hold = true;
    queueCursor();
    editHooks.unshift(typeAhead);
    drawTypeAhead();
    // If it never comes up, the text goes to the clipboard rather than being lost.
    ahead.giveUpTimer = setTimeout(() => finishTypeAhead(false), 30000);
    r7.log('info', 'typeahead.start', { session: cfg.session });
  }

  function typeAhead(data) {
    const pasted = data.startsWith('\x1b[200~');
    if (data === '\r') return true;
    // Ctrl+C with nothing typed still reaches the launch, to stop it.
    if (data === '\x03' && !ahead.text) return false;
    if (data === '\x7f' || data === '\b') ahead.text = [...ahead.text].slice(0, -1).join('');
    else if (data === '\x17') ahead.text = ahead.text.replace(/\S*\s*$/, '');
    else if (data === '\x15' || data === '\x03') ahead.text = '';
    else if (data === '\x1b\r') ahead.text += '\n';
    else if (data.startsWith('\x1b') && !pasted) return true;
    else {
      // Typed characters and pastes; pasted line breaks arrive as \r.
      const text = data.replace(/\x1b\[20[01]~/g, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
      ahead.text += text;
    }
    drawTypeAhead();
    return true;
  }

  // Word-wrapped like an editor.
  function wrap(text, width) {
    const lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/(?<= )/)) {
        if ([...line + word].length > width && line) { lines.push(line); line = ''; }
        let w = word;
        while ([...w].length > width) { lines.push([...w].slice(0, width).join('')); w = [...w].slice(width).join(''); }
        line += w;
      }
      lines.push(line);
    }
    return lines;
  }

  // Plain text from the top-left of the launch screen, above the water. It shows only once
  // something is typed; the launch screen is otherwise empty above the water.
  function drawTypeAhead() {
    const el = ahead.el;
    if (!el) return;
    el.hidden = !ahead.text;
    if (el.hidden) return;
    const cw = cellWidth();
    const rh = rowHeight();
    const lines = wrap(ahead.text, term.cols - 2);
    el.style.setProperty('--edge', colors.cursor || colors.fg);
    el.style.color = colors.fg;
    el.style.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
    el.style.lineHeight = `${rh}px`;
    el.style.left = `${cw}px`;
    el.style.top = `${rh}px`;
    el.style.width = `${(term.cols - 2) * cw}px`;
    el.style.height = `${lines.length * rh}px`;
    const rows = lines.map((line, i) => {
      const div = document.createElement('div');
      div.className = 'line';
      div.style.top = `${i * rh}px`;
      div.textContent = line;
      if (i === lines.length - 1) {
        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.style.width = `${cw}px`;
        div.append(caret);
      }
      return div;
    });
    el.replaceChildren(...rows);
  }

  function checkReady() {
    if (!ahead.on || ahead.readyTimer) return;
    if (!term.modes.bracketedPasteMode || readyRow() < 0) return;
    // A short wait after the first ready frame, so its editor is listening.
    ahead.readyTimer = setTimeout(() => {
      ahead.readyTimer = 0;
      if (readyRow() >= 0) finishTypeAhead(true);
    }, 120);
  }

  // Long pastes become a [Paste #1] marker in some agents,
  // so long text goes in as several smaller pastes, split before a space.
  function pasteChunks(text) {
    const chunks = [];
    while (text) {
      let n = text.length;
      if (n > 900 || text.split('\n').length > 10) {
        n = Math.min(900, text.split('\n').slice(0, 10).join('\n').length);
        const space = text.lastIndexOf(' ', n);
        if (space > 0) n = space;
      }
      chunks.push(text.slice(0, n));
      text = text.slice(n);
    }
    return chunks;
  }

  function finishTypeAhead(ready) {
    if (!ahead.on) return;
    ahead.on = false;
    clearTimeout(ahead.giveUpTimer);
    clearTimeout(ahead.readyTimer);
    editHooks.splice(editHooks.indexOf(typeAhead), 1);
    glide.hold = false;
    queueCursor();
    ahead.el.remove();
    ahead.el = null;
    const top = readyRow();
    launch.end(top >= 0 ? top : undefined);
    const text = ahead.text;
    r7.log('info', 'typeahead.done', { session: cfg.session, ready, chars: text.length });
    if (!text) return;
    if (!ready) { r7.writeClipboard(text); status('typed text copied to the clipboard'); setTimeout(() => status(''), 4000); return; }
    for (const chunk of pasteChunks(text)) sendInput(`\x1b[200~${chunk}\x1b[201~`);
  }

  // Only the first attach of a session that's still starting: little output, no box yet.
  snapshotListeners.push((msg, data) => {
    if (ahead.done) return;
    ahead.done = true;
    const showCursor = () => { glide.hold = false; queueCursor(); };
    if (!launchReady || data.length > 4000 || msg.exitCode != null) return showCursor();
    term.write('', () => { if (readyRow() >= 0) showCursor(); else startTypeAhead(); });
  });
  term.onWriteParsed(checkReady);
  term.onResize(() => { if (ahead.on) drawTypeAhead(); });
  colorListeners.push(() => { if (ahead.on) drawTypeAhead(); });

  // ---- mouse editing in the input box --------------------------------------------
  // Dragging over the box's text selects it the way a text field does: along the text,
  // never the border or padding. Typing or pasting replaces the selection, Backspace or
  // Delete removes it, Ctrl+C copies it, and the cursor shows as a line meanwhile.
  // Ctrl+click moves the cursor. r7Harness takes both as `CSI 7321 ; row ; col [; row ; col] ~`
  // (visible text row and column); older sessions get Ctrl+click as arrow keys and
  // keep the terminal's plain selection.

  const KEYS = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
  // The click that brings the window forward only activates it.
  let focusedAt = document.hasFocus() ? 0 : Infinity;
  window.addEventListener('focus', () => { focusedAt = performance.now(); });
  window.addEventListener('blur', () => { focusedAt = Infinity; });

  const sel = { box: null, anchor: null, head: null, dragging: false, text: '', el: null };
  sel.el = document.createElement('div');
  sel.el.id = 'box-selection';
  screenEl.appendChild(sel.el);

  // The first column after the row's last character, or the text start for an empty row.
  function rowEnd(row) {
    const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
    let end = TEXT_COL;
    for (let x = TEXT_COL; x < term.cols - 3; x++) {
      const cell = line.getCell(x);
      if (cell && cell.getChars() && cell.getChars() !== ' ') end = x + cell.getWidth();
    }
    return end;
  }

  // The text position nearest the pointer: a row inside the box, a column between cells.
  function spotAt(e, box) {
    const rect = screenEl.getBoundingClientRect();
    const row = Math.max(box.top + 1, Math.min(box.bottom, Math.floor((e.clientY - rect.top) / rowHeight())));
    const col = Math.round((e.clientX - rect.left) / cellWidth());
    return { row, col: Math.max(TEXT_COL, Math.min(col, rowEnd(row))) };
  }

  function inBoxText(e, box) {
    const rect = screenEl.getBoundingClientRect();
    const row = Math.floor((e.clientY - rect.top) / rowHeight());
    const col = Math.floor((e.clientX - rect.left) / cellWidth());
    return row > box.top && row <= box.bottom && col >= 1 && col < term.cols - 1;
  }

  const before = (a, b) => a.row < b.row || (a.row === b.row && a.col <= b.col);
  function ordered() { return before(sel.anchor, sel.head) ? [sel.anchor, sel.head] : [sel.head, sel.anchor]; }
  const boxRowsText = (box) => { const t = []; for (let r = box.top; r <= box.bottom; r++) t.push(rowText(term.buffer.active.viewportY + r)); return t.join('\n'); };

  function hasSelection() { return !!sel.anchor && (sel.anchor.row !== sel.head.row || sel.anchor.col !== sel.head.col); }

  function drawSelection() {
    sel.el.replaceChildren();
    glide.forceShape = hasSelection() ? 'bar' : null;
    queueCursor();
    if (!hasSelection()) return;
    const [a, b] = ordered();
    const cw = cellWidth();
    const rh = rowHeight();
    const color = cfg.theme.selectionBackground || '#9367FB';
    for (let r = a.row; r <= b.row; r++) {
      const from = r === a.row ? a.col : TEXT_COL;
      const to = r === b.row ? b.col : Math.max(rowEnd(r), TEXT_COL + 1);
      if (to <= from) continue;
      const div = document.createElement('div');
      div.style.cssText = `left:${from * cw}px;top:${r * rh}px;width:${(to - from) * cw}px;height:${rh}px;background:${color}88`;
      sel.el.append(div);
    }
  }

  function clearSelection() {
    if (!sel.anchor) return;
    sel.anchor = sel.head = sel.box = null;
    drawSelection();
  }

  function selectedText() {
    const [a, b] = ordered();
    const lines = [];
    for (let r = a.row; r <= b.row; r++) {
      const text = rowText(term.buffer.active.viewportY + r);
      lines.push([...text].slice(r === a.row ? a.col : TEXT_COL, r === b.row ? b.col : rowEnd(r)).join(''));
    }
    return lines.join('\n');
  }

  const editCmd = (...spots) => `\x1b[7321;${spots.map((p) => `${p.row - sel.box.top - 1};${p.col - TEXT_COL}`).join(';')}~`;

  function editReady(e) {
    if (e.button !== 0 || ahead.on || term.modes.mouseTrackingMode !== 'none') return null;
    if (!document.hasFocus() || performance.now() - focusedAt < 300) return null;
    const buf = term.buffer.active;
    if (buf.viewportY !== buf.baseY) return null;
    const box = findBox();
    if (!box || !inBoxText(e, box)) return null;
    if (buf.cursorY <= box.top || buf.cursorY > box.bottom) return null;
    return box;
  }

  screenEl.addEventListener('mousedown', (e) => {
    const box = editReady(e);
    if (!box) { clearSelection(); return; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      clearSelection();
      term.clearSelection();
      moveTo(box, spotAt(e, box));
      term.focus();
      return;
    }
    if (!harness.mouseEditing || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    term.clearSelection();
    term.focus();
    const spot = spotAt(e, box);
    sel.box = box;
    if (e.detail === 2) {
      // Double-click: the word under the pointer.
      const text = [...rowText(term.buffer.active.viewportY + spot.row)];
      let from = Math.min(spot.col, rowEnd(spot.row) - 1);
      let to = from;
      while (from > TEXT_COL && /\S/.test(text[from - 1] || '')) from--;
      while (to < rowEnd(spot.row) && /\S/.test(text[to] || '')) to++;
      sel.anchor = { row: spot.row, col: from };
      sel.head = { row: spot.row, col: to };
    } else if (e.detail >= 3) {
      sel.anchor = { row: box.top + 1, col: TEXT_COL };
      sel.head = { row: box.bottom, col: rowEnd(box.bottom) };
    } else {
      sel.anchor = spot;
      sel.head = spot;
      sel.dragging = true;
    }
    sel.text = boxRowsText(box);
    drawSelection();
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!sel.dragging) return;
    sel.head = spotAt(e, sel.box);
    drawSelection();
  });
  document.addEventListener('mouseup', () => {
    if (!sel.dragging) return;
    sel.dragging = false;
    if (!hasSelection()) clearSelection();
  });

  // The selection goes away once the box changes by anything but this.
  term.onWriteParsed(() => {
    if (!sel.anchor || sel.dragging) return;
    const box = findBox();
    if (!box || box.top !== sel.box.top || boxRowsText(box) !== sel.text) clearSelection();
  });
  term.onResize(clearSelection);

  document.addEventListener('keydown', (e) => {
    if (!hasSelection()) return;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    if (ctrl && (e.key === 'c' || e.key === 'C')) {
      r7.writeClipboard(selectedText());
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (e.key === 'Escape') {
      clearSelection();
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // Keys that type text replace the selection; Backspace/Delete remove it; anything else
  // (arrows, Enter, undo) just drops it.
  editHooks.push((data) => {
    if (!hasSelection()) return false;
    const [a, b] = ordered();
    const cmd = editCmd(a, b);
    clearSelection();
    if (data === '\x7f' || data === '\b' || data === '\x1b[3~') { sendRaw(cmd); return true; }
    const typed = data.startsWith('\x1b[200~') || data === '\x1b\r' || !/^[\x00-\x1f\x7f]/.test(data);
    if (!typed) return false;
    sendRaw(cmd + data);
    return true;
  });

  function moveTo(box, spot) {
    if (harness.mouseEditing) {
      sendRaw(`\x1b[7321;${spot.row - box.top - 1};${spot.col - TEXT_COL}~`);
      return;
    }
    const buf = term.buffer.active;
    const dy = spot.row - buf.cursorY;
    if (dy) sendRaw((dy < 0 ? KEYS.up : KEYS.down).repeat(Math.abs(dy)));
    if (!dy) { moveAcross(spot); return; }
    // Wait for the program to put the cursor on that row, then fix the column.
    const started = performance.now();
    const settle = () => {
      if (term.buffer.active.cursorY === spot.row) { moveAcross(spot); return; }
      if (performance.now() - started < 300) setTimeout(settle, 10);
    };
    setTimeout(settle, 10);
  }

  // Left and right count characters, so a wide character (two cells) is one press.
  function moveAcross(spot) {
    const buf = term.buffer.active;
    const line = buf.getLine(buf.viewportY + spot.row);
    const from = buf.cursorX;
    const [a, b] = from < spot.col ? [from, spot.col] : [spot.col, from];
    let presses = 0;
    for (let x = a; x < b; x++) if (line.getCell(x)?.getWidth()) presses++;
    if (presses) sendRaw((from < spot.col ? KEYS.right : KEYS.left).repeat(presses));
  }
})();
