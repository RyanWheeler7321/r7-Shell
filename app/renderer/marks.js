'use strict';
// Reply titles, pictures and questions. r7Harness starts a row with a private
// OSC 7321 when it runs here: `title` redraws that row's text 1.3x, and
// `image;<rows>;<cols>;<path>` draws the picture over the blank rows above its
// caption. Each mark checks its row after every write and goes away once the
// program has redrawn that row with something else.

(() => {
  const TITLE_SCALE = 1.3;
  const marks = [];
  const pending = [];
  let checkQueued = false;

  const cellWidth = () => screenEl.clientWidth / term.cols;
  const rowText = (y) => term.buffer.active.getLine(y)?.translateToString(true) ?? null;

  function fileUrl(path) {
    let p = path.replace(/\\/g, '/');
    const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
    if (drive) p = `${drive[1].toUpperCase()}:/${drive[2]}`;
    else if (p.startsWith('/')) return `file://wsl.localhost/${cfg.distro}` + p.split('/').map(encodeURIComponent).join('/');
    const parts = p.split('/');
    return 'file:///' + [parts[0], ...parts.slice(1).map(encodeURIComponent)].join('/');
  }

  function cellColor(cell) {
    if (cell.isFgRGB()) return '#' + cell.getFgColor().toString(16).padStart(6, '0');
    if (cell.isFgPalette()) return colors.palette[cell.getFgColor()] || colors.fg;
    return colors.fg;
  }

  function drop(mark) {
    mark.deco?.dispose();
    mark.marker.dispose();
    const i = marks.indexOf(mark);
    if (i >= 0) marks.splice(i, 1);
  }

  // The row's text from the mark on, as colored spans.
  function titleSpans(y, x, spans = []) {
    const line = term.buffer.active.getLine(y);
    if (!line) return spans;
    let cell;
    for (let i = x; i < line.length; i++) {
      cell = line.getCell(i, cell);
      if (!cell || cell.getWidth() === 0) continue;
      const ch = cell.getChars() || ' ';
      const color = cellColor(cell);
      const bold = !!cell.isBold();
      const last = spans[spans.length - 1];
      if (last && last.color === color && last.bold === bold) last.text += ch;
      else spans.push({ text: ch, color, bold });
    }
    while (spans.length && !spans[spans.length - 1].text.trim()) spans.pop();
    if (spans.length) spans[spans.length - 1].text = spans[spans.length - 1].text.replace(/\s+$/, '');
    return spans;
  }

  function drawTitle(mark, el) {
    el.classList.add('r7-title');
    const inner = document.createElement('div');
    inner.className = 'r7-title-text';
    for (const s of mark.spans) {
      const span = document.createElement('span');
      span.textContent = s.text;
      span.style.color = s.color;
      if (s.bold) span.style.fontWeight = 'bold';
      inner.append(span);
    }
    el.replaceChildren(inner);
    fitTitle(mark, inner);
  }

  // Always TITLE_SCALE, on one line when it fits. A longer title wraps, centered over its
  // own rows and spilling into the blank rows above and below. The box always covers the
  // title's own rows, so none of the plain text shows through.
  function fitTitle(mark, inner) {
    const width = (term.cols - mark.x) * cellWidth();
    const rowPx = rowHeight();
    const y = mark.marker.line;
    let below = 0;
    while (below < 3 && rowText(y + mark.rows + below)?.trim() === '') below++;
    let above = 0;
    while (above < 2 && y - above - 1 >= 0 && rowText(y - above - 1)?.trim() === '') above++;
    inner.style.font = `${term.options.fontSize * TITLE_SCALE}px ${term.options.fontFamily}`;
    inner.style.lineHeight = `${rowPx * TITLE_SCALE}px`;
    inner.classList.remove('wrap');
    inner.style.width = '';
    inner.style.minHeight = '';
    inner.style.top = `${-rowPx * (TITLE_SCALE - 1) / 2}px`;
    inner.style.height = `${Math.max(rowPx * TITLE_SCALE, rowPx * (mark.rows + (TITLE_SCALE - 1) / 2))}px`;
    if (inner.scrollWidth <= width) return;
    inner.classList.add('wrap');
    inner.style.width = `${width}px`;
    inner.style.height = '';
    inner.style.minHeight = `${rowPx * mark.rows}px`;
    const spill = Math.max(0, inner.scrollHeight - mark.rows * rowPx);
    // Centered, shifted up when the rows below are short, never above the blank rows there.
    const up = Math.min(above * rowPx, Math.max(spill / 2, spill - below * rowPx));
    inner.style.top = `${-up}px`;
  }

  function drawImage(mark, el) {
    el.classList.add('r7-image');
    const img = document.createElement('img');
    img.src = fileUrl(mark.path);
    img.dataset.path = mark.path;
    img.alt = '';
    // Sized to the picture itself so the rounded corners sit on it.
    img.addEventListener('load', () => {
      const w = el.clientWidth;
      const h = el.clientHeight - 6;
      const scale = Math.min(1, w / img.naturalWidth, h / img.naturalHeight);
      img.style.width = `${Math.round(img.naturalWidth * scale)}px`;
      img.style.height = `${Math.round(img.naturalHeight * scale)}px`;
    });
    img.addEventListener('error', () => r7.log('warn', 'marks.image_error', { session: cfg.session, path: mark.path }));
    el.replaceChildren(img);
  }

  function place(mark) {
    const opts = mark.kind === 'title'
      ? { marker: mark.marker, x: mark.x, width: Math.max(1, term.cols - mark.x), height: 1, layer: 'top' }
      : { marker: mark.marker, x: mark.x, width: Math.min(mark.cols, term.cols - mark.x), height: mark.rows, layer: 'top' };
    mark.deco = term.registerDecoration(opts);
    if (!mark.deco) return drop(mark);
    let drawnAt = '';
    mark.deco.onRender((el) => {
      mark.el = el;
      // Redraw when the font size changes; otherwise the element is kept as is.
      const key = `${term.options.fontSize}|${rowHeight()}`;
      if (key === drawnAt) return;
      drawnAt = key;
      if (mark.kind === 'title') drawTitle(mark, el);
      else drawImage(mark, el);
    });
  }

  function still(mark) {
    if (mark.marker.isDisposed || mark.marker.line < 0) return false;
    if (mark.kind === 'title') return rowText(mark.marker.line) === mark.text;
    if (rowText(mark.marker.line + mark.rows) !== mark.text) return false;
    return !rowText(mark.marker.line)?.trim() && !rowText(mark.marker.line + mark.rows - 1)?.trim();
  }

  function settle() {
    checkQueued = false;
    for (const mark of pending.splice(0)) {
      if (mark.marker.isDisposed) continue;
      const y = mark.kind === 'title' ? mark.marker.line : mark.marker.line + mark.rows;
      mark.text = rowText(y);
      if (mark.kind === 'title') {
        mark.spans = titleSpans(y, mark.x);
        if (!mark.spans.length) { mark.marker.dispose(); continue; }
        // A title longer than the window continues on the next rows in the same bold color.
        mark.rows = 1;
        const color = mark.spans[0].color;
        while (mark.rows < 4) {
          const cell = term.buffer.active.getLine(y + mark.rows)?.getCell(mark.x);
          if (!cell || !cell.getChars().trim() || !cell.isBold() || cellColor(cell) !== color) break;
          mark.spans.push({ text: ' ', color, bold: true });
          titleSpans(y + mark.rows, mark.x, mark.spans);
          mark.rows++;
        }
      }
      // A redrawn row replaces the mark it had.
      for (const old of marks.filter((m) => m.marker.line === mark.marker.line && m.kind === mark.kind)) drop(old);
      marks.push(mark);
      place(mark);
    }
  }

  // A mark whose row was redrawn goes when the screen shows the change, not when the
  // text arrives: dropped earlier, its row would show plain for a frame.
  // Only rows this render drew can have changed.
  term.onRender(({ start, end }) => {
    const top = term.buffer.active.viewportY;
    for (const mark of [...marks]) {
      const y = mark.marker.line;
      const last = y + (mark.kind === 'title' ? 0 : mark.rows);
      if (y >= 0 && (last < top + start || y > top + end)) continue;
      if (!still(mark)) drop(mark);
    }
  });

  // ---- clickable questions ------------------------------------------------------
  // Question lines start with "1?", "2?" in the template's `questionColor`. Clicking one
  // types its number into the input box, ready for the answer. A bare "?" line counts
  // its place among the question lines right above it.
  const ASK_COLOR = (cfg.questionColor || '#ffc857').toLowerCase();
  const ASK_RE = /^(\s{0,3})(\d*\?)\s+(\S.*?)\s*$/;

  function askLine(y) {
    const line = term.buffer.active.getLine(y);
    const m = line && ASK_RE.exec(line.translateToString(true));
    if (!m) return null;
    const cell = line.getCell(m[1].length);
    return cell && cellColor(cell).toLowerCase() === ASK_COLOR ? m : null;
  }

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const m = askLine(y - 1);
      if (!m) return callback(undefined);
      const x = m[1].length;
      const question = m[3];
      let number = m[2].slice(0, -1);
      if (!number) {
        let above = 0;
        while (askLine(y - 2 - above)) above++;
        number = String(above + 1);
      }
      const answer = `${number}: `;
      callback([{
        text: m[0].trim(),
        range: { start: { x: x + 1, y }, end: { x: x + m[2].length + 1 + question.length, y } },
        decorations: { underline: true, pointerCursor: true },
        activate: () => {
          const paste = term.modes.bracketedPasteMode ? `\x1b[200~${answer}\x1b[201~` : answer;
          followBottom = true;
          sendInput(paste);
          term.focus();
          r7.log('info', 'marks.question', { session: cfg.session, marker: m[2] });
        },
      }]);
    },
  });

  term.onWriteParsed(() => {
    queueTaskTitle();
    if (checkQueued || (!pending.length && !marks.length)) return;
    checkQueued = true;
    queueMicrotask(settle);
  });

  // ---- task title above the input box ---------------------------------------------
  // r7Harness's `5m | Task title` row sits right above the input box's top border. It's
  // drawn TITLE_SCALE like reply titles, and scrolls in a loop when it doesn't fit.
  const TASK_RE = /^\s*(\d+m|✦) \| \S/;
  const taskEl = document.createElement('div');
  taskEl.id = 'r7-task-title';
  screenEl.appendChild(taskEl);
  let taskQueued = false;
  let taskDrawn = '';
  let taskY = -1;

  function queueTaskTitle() {
    if (taskQueued || !harness.on) return;
    taskQueued = true;
    setTimeout(drawTaskTitle, 30);
  }

  function findTaskRow() {
    const buf = term.buffer.active;
    for (let r = term.rows - 2; r >= 0; r--) {
      const text = rowText(buf.viewportY + r);
      if (text && TASK_RE.test(text) && /^\s*╭/.test(rowText(buf.viewportY + r + 1) || '')) return r;
    }
    return -1;
  }

  function drawTaskTitle() {
    taskQueued = false;
    const r = findTaskRow();
    if (r < 0) { taskEl.style.display = 'none'; taskDrawn = ''; taskY = -1; return; }
    const y = term.buffer.active.viewportY + r;
    taskY = y;
    const x = rowText(y).search(/\S/);
    const spans = titleSpans(y, x);
    const rowPx = rowHeight();
    const key = `${r}|${x}|${term.options.fontSize}|${rowPx}|${term.cols}|` + spans.map((s) => s.color + s.text).join('');
    taskEl.style.display = '';
    if (key === taskDrawn) return;
    taskDrawn = key;
    // Bottom-aligned on its row, so the extra height goes up into the blank row above.
    taskEl.style.left = `${x * cellWidth()}px`;
    taskEl.style.width = `${(term.cols - x) * cellWidth()}px`;
    taskEl.style.top = `${(r + 1) * rowPx - rowPx * TITLE_SCALE}px`;
    // A few pixels past the row, so tall glyphs like | in the plain row don't peek out.
    taskEl.style.height = `${rowPx * TITLE_SCALE + 3}px`;
    taskEl.style.font = `${term.options.fontSize * TITLE_SCALE}px ${term.options.fontFamily}`;
    taskEl.style.lineHeight = `${rowPx * TITLE_SCALE}px`;
    const line = () => {
      const el = document.createElement('span');
      el.className = 'r7-task-line';
      for (const s of spans) {
        const span = document.createElement('span');
        span.textContent = s.text;
        span.style.color = s.color;
        if (s.bold) span.style.fontWeight = 'bold';
        el.append(span);
      }
      return el;
    };
    const track = document.createElement('div');
    track.className = 'r7-task-track';
    track.append(line());
    taskEl.replaceChildren(track);
    const overflow = track.scrollWidth - taskEl.clientWidth;
    if (overflow <= 0) return;
    // Two copies side by side, sliding one copy's width, so the loop is seamless.
    track.append(line());
    const shift = track.firstChild.getBoundingClientRect().width;
    track.style.setProperty('--shift', `${-shift}px`);
    track.style.animationDuration = `${Math.max(6, shift / 40)}s`;
    track.classList.add('loop');
  }

  window.addEventListener('resize', queueTaskTitle);
  term.onScroll(queueTaskTitle);

  // A selection over a 1.3x title highlights the title's own letters, scaled like them:
  // the selected columns of its row, or all of it when the title wraps.
  function showSelection() {
    const p = term.getSelectionPosition();
    const hit = (y, rows) => !!p && p.start.y <= y + rows - 1 && p.end.y >= y;
    const color = term.options.theme.selectionBackground;
    for (const mark of marks) {
      if (mark.kind !== 'title' || !mark.el) continue;
      const inner = mark.el.querySelector('.r7-title-text');
      if (!inner) continue;
      inner.querySelector('.r7-title-sel')?.remove();
      const y = mark.marker.line;
      if (!hit(y, mark.rows)) continue;
      const sel = document.createElement('div');
      sel.className = 'r7-title-sel';
      sel.style.background = color;
      if (!inner.classList.contains('wrap') && mark.rows === 1) {
        const from = Math.max(0, (p.start.y < y ? 0 : p.start.x) - mark.x);
        const to = Math.min(mark.text.length, p.end.y > y ? term.cols : p.end.x) - mark.x;
        if (to <= from) continue;
        const step = cellWidth() * TITLE_SCALE;
        sel.style.left = `${from * step}px`;
        sel.style.width = `${(to - from) * step}px`;
      }
      inner.prepend(sel);
    }
    taskEl.style.background = taskY >= 0 && hit(taskY, 1) ? color : '';
  }
  term.onSelectionChange(showSelection);

  term.parser.registerOscHandler(7321, (data) => {
    const parts = data.split(';');
    const x = term.buffer.active.cursorX;
    if (parts[0] === 'title') {
      pending.push({ kind: 'title', x, marker: term.registerMarker(0) });
    } else if (parts[0] === 'image' && parts.length >= 4) {
      const rows = Math.max(1, parseInt(parts[1], 10) || 0);
      const cols = Math.max(1, parseInt(parts[2], 10) || 0);
      let path;
      try { path = decodeURIComponent(parts.slice(3).join(';')); } catch { return true; }
      const marker = term.registerMarker(-rows);
      if (marker) pending.push({ kind: 'image', x, rows, cols, path, marker });
    } else return false;
    return true;
  });
})();
