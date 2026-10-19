'use strict';
// Reply titles, pictures and questions. r7-Harness starts a row with a private
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
    mark.el?.remove();
    mark.marker.dispose();
    const i = marks.indexOf(mark);
    if (i >= 0) marks.splice(i, 1);
  }

  // The row's text from the mark on, as colored spans.
  function titleSpans(y, x, spans = [], end = Infinity) {
    const line = term.buffer.active.getLine(y);
    if (!line) return spans;
    let cell;
    for (let i = x; i < Math.min(end, line.length); i++) {
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
    const version = r7.fileVersion ? r7.fileVersion(mark.path) : Promise.resolve(0);
    version.catch(() => 0).then((v) => { img.src = fileUrl(mark.path) + (v ? `?v=${v}` : ''); });
  }

  // Titles and pictures aren't xterm decorations: xterm draws a new decoration, and moves
  // one when the screen shifts, a frame after the text, so a title showed plain for a frame
  // on every shift (Ctrl+J), and it hides one while its first row is above the screen.
  // They're placed here in the same render instead, shown while any of their rows is on
  // screen (the extra row under a smooth scroll included), in the decoration layer so
  // they sit and glide (fade.js) the same.
  function placeMark(mark) {
    const buf = term.buffer.active;
    const t = mark.marker.line - buf.viewportY;
    if (buf.type !== 'normal' || t + mark.rows <= 0 || t > term.rows) {
      if (mark.el) mark.el.style.display = 'none';
      return;
    }
    if (!mark.el) {
      mark.el = document.createElement('div');
      mark.el.className = `xterm-decoration xterm-decoration-top-layer r7-${mark.kind}`;
      (screenEl.querySelector('.xterm-decoration-container') || screenEl).append(mark.el);
    }
    const el = mark.el;
    const rowPx = rowHeight();
    const cw = cellWidth();
    const cols = mark.kind === 'image' ? Math.min(mark.cols, term.cols - mark.x) : term.cols - mark.x;
    el.style.display = 'block';
    el.style.top = `${t * rowPx}px`;
    el.style.left = `${mark.x * cw}px`;
    el.style.width = `${Math.round(Math.max(1, cols) * cw)}px`;
    el.style.height = `${(mark.kind === 'image' ? mark.rows : 1) * rowPx}px`;
    const key = `${term.options.fontSize}|${rowPx}|${term.cols}`;
    if (key === mark.drawnAt) return;
    mark.drawnAt = key;
    if (mark.kind === 'image') drawImage(mark, el);
    else drawTitle(mark, el);
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
      // A redrawn row replaces the mark it had. The new mark takes over its element, which
      // stays where it is until the render that shows the new text moves it (onRender):
      // placed now, it moved a frame ahead of the text and the plain title showed under it.
      for (const old of marks.filter((m) => m.marker.line === mark.marker.line && m.kind === mark.kind)) {
        if (old.el && !mark.el) {
          mark.el = old.el;
          if (sameLook(old, mark)) mark.drawnAt = old.drawnAt;
          old.el = null;
        }
        drop(old);
      }
      marks.push(mark);
    }
    // The render that shows these rows places them. This only covers a write that brings
    // no render; a frame callback here could run before xterm's and show a title early.
    setTimeout(() => { for (const mark of marks) if (!mark.el) placeMark(mark); }, 100);
  }

  function sameLook(a, b) {
    if (a.kind === 'image') return a.path === b.path && a.rows === b.rows && a.cols === b.cols && a.x === b.x;
    return a.rows === b.rows && a.x === b.x && JSON.stringify(a.spans) === JSON.stringify(b.spans);
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
    for (const mark of marks) placeMark(mark);
  });

  // ---- clickable questions ------------------------------------------------------
  // Question lines start with "1?", "2?" in the template's `questionColor`. Clicking one
  // types its number into the input box, ready for the answer. A bare "?" line counts
  // its place among the question lines right above it.
  const ASK_COLOR = (cfg.questionColor || '#ffc857').toLowerCase();
  // Allow the leading margin of a centered column.
  const ASK_RE = /^(\s*)(\d*\?)\s+(\S.*?)\s*$/;

  function askLine(y) {
    const line = term.buffer.active.getLine(y);
    const m = line && ASK_RE.exec(line.translateToString(true));
    if (!m) return null;
    const cell = line.getCell(m[1].length);
    return cell && cellColor(cell).toLowerCase() === ASK_COLOR ? m : null;
  }

  // A question's number: its own, or for a bare "?" its place among the lines above.
  function askNumber(y, m) {
    const own = m[2].slice(0, -1);
    if (own) return own;
    let above = 0;
    while (askLine(y - 1 - above)) above++;
    return String(above + 1);
  }

  // The input box measured from the bottom of the live screen, even while scrolled up
  // (findBox only answers at the bottom). Rows are buffer lines.
  function liveBox() {
    const buf = term.buffer.active;
    if (buf.type !== 'normal') return null;
    let bottom = -1, left = 0;
    for (let r = term.rows - 1; r >= 0; r--) {
      const text = buf.getLine(buf.baseY + r)?.translateToString(true) || '';
      if (bottom < 0) {
        const m = /^( *)╰─.*╯$/.exec(text);
        if (m) { bottom = buf.baseY + r; left = m[1].length; }
      } else if (/^ *╭/.test(text)) return { top: buf.baseY + r, bottom, left };
      else if (!/^ *│/.test(text)) return null;
    }
    return null;
  }

  // Read text at `left + 3`, including the last row inside the bottom border.
  function boxRows(box) {
    const rows = [];
    for (let y = box.top + 1; y <= box.bottom; y++) {
      const line = term.buffer.active.getLine(y);
      rows.push((line?.translateToString(true, box.left + 3) || '').replace(/\s*(─*╯|[│▕█])\s*$/, '').trimEnd());
    }
    return rows;
  }

  // Whether the cursor's row in the box already has text, so the answer starts on a new
  // line. The cursor's row is often the bottom border row.
  function cursorRowHasText(box) {
    const buf = term.buffer.active;
    const y = buf.baseY + buf.cursorY;
    if (!box || y <= box.top || y > box.bottom) return false;
    return boxRows(box)[y - box.top - 1].trim().length > 0;
  }

  // Numbers still hopping, oldest first. They're typed in this order whatever lands first,
  // and a key you press types them all before itself.
  const hopping = [];
  let typingAnswer = false;
  let typedAt = 0; // when a number was last typed, before the box may have redrawn it
  function typeAnswers(upTo) {
    while (hopping.length) {
      const a = hopping.shift();
      typingAnswer = true;
      try { sendInput(a.text); } finally { typingAnswer = false; }
      typedAt = performance.now();
      // Taken out after this key's own pass through the hooks.
      setTimeout(() => { const i = editHooks.indexOf(a.early); if (i >= 0) editHooks.splice(i, 1); });
      if (a === upTo) break;
    }
  }

  // Puts "N: " in the box on a line of its own: a new line first when the cursor's row
  // has text (or another number is still on its way), then the number hops from the
  // question into the box and is typed when it lands, or at once if a key comes first, so
  // it always goes ahead of what you type next. `qy` is the question's buffer line.
  function answerQuestion(qy, x, number, via) {
    const answer = `${number}: `;
    const paste = term.modes.bracketedPasteMode ? `\x1b[200~${answer}\x1b[201~` : answer;
    picked.numbers.add(number);
    picked.at = performance.now();
    followBottom = true;
    term.focus();
    const queued = hopping.length > 0;
    const newLine = queued || performance.now() - typedAt < 500 || cursorRowHasText(liveBox());
    r7.log('info', 'marks.question', { session: cfg.session, number, via, newLine });
    // Behind another number, the line break waits to be typed after it.
    const a = { text: queued ? `\x1b\r${paste}` : paste };
    a.early = () => { if (!typingAnswer) typeAnswers(); return false; };
    const send = () => { if (hopping.includes(a)) typeAnswers(a); };
    const fly = () => {
      if (!hopping.includes(a)) return;
      const buf = term.buffer.active;
      const box = findBox();
      const from = { x, y: qy - buf.viewportY };
      const to = box && buf.cursorY > box.top && buf.cursorY <= box.bottom
        ? { x: buf.cursorX, y: buf.cursorY } : box ? { x: box.left + 3, y: box.top + 1 } : null;
      if (!to || from.y < 0 || from.y >= term.rows) { send(); return; }
      motion.hop(`${number}:`, from, to, ASK_COLOR, send);
    };
    // The new line goes out before the hook is set: sendInput runs the edit hooks too,
    // and the hook would type the number ahead of its own line break.
    if (newLine && !queued) sendInput('\x1b\r');
    hopping.push(a);
    editHooks.unshift(a.early);
    if (!newLine || queued) { fly(); return; }
    // Aim the hop after the new line has redrawn.
    const startY = term.buffer.active.baseY + term.buffer.active.cursorY;
    let done = false;
    const go = () => { if (done) return; done = true; watch.dispose(); clearTimeout(timer); fly(); };
    const watch = term.onRender(() => {
      const buf = term.buffer.active;
      if (buf.baseY + buf.cursorY !== startY || buf.cursorX <= (liveBox()?.left ?? 0) + 3) go();
    });
    const timer = setTimeout(go, 150);
  }

  // Numbers put in the box for the current reply's questions. The box only shows its last
  // rows once an answer grows long, and a number still hopping isn't typed yet, so the
  // box text alone can miss them. Cleared when a new reply's questions come or the box has
  // been emptied (sent) since the last pick.
  const picked = { key: -1, numbers: new Set(), at: 0 };

  // Ctrl+Up: the next question of the latest reply whose number isn't in the box yet,
  // lowest first. Returns false when the latest reply has no questions, so the key goes on.
  window.r7NextQuestion = () => {
    const box = liveBox();
    if (!box) return false;
    const found = [];
    for (let y = box.top - 1, seen = 0; y >= 0 && seen < 400; y--, seen++) {
      const text = (term.buffer.active.getLine(y)?.translateToString(true) || '').trimStart().slice(0, 4);
      if (messageStart && messageStart.test(text)) break;
      const m = askLine(y);
      if (m) found.push({ y, x: m[1].length, number: askNumber(y, m) });
    }
    if (!found.length) return false;
    const rows = boxRows(box);
    const key = found[found.length - 1].y;
    const emptied = rows.every((row) => !row.trim()) && performance.now() - picked.at > 1000;
    if (picked.key !== key || emptied) { picked.key = key; picked.numbers.clear(); }
    const answered = new Set(rows.map((row) => /^\s*(\d+):/.exec(row)?.[1]).filter(Boolean));
    for (const n of picked.numbers) answered.add(n);
    const next = found.filter((q) => !answered.has(q.number)).sort((a, b) => Number(a.number) - Number(b.number))[0];
    const seen = [...answered].sort();
    if (!next) { r7.log('info', 'marks.question.none', { session: cfg.session, count: found.length, answered: seen }); return true; }
    r7.log('info', 'marks.question.pick', { session: cfg.session, count: found.length, answered: seen, boxRows: rows.length });
    answerQuestion(next.y, next.x, next.number, 'ctrl+up');
    return true;
  };

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const m = askLine(y - 1);
      if (!m) return callback(undefined);
      const x = m[1].length;
      const question = m[3];
      const number = askNumber(y - 1, m);
      callback([{
        text: m[0].trim(),
        range: { start: { x: x + 1, y }, end: { x: x + m[2].length + 1 + question.length, y } },
        decorations: { underline: true, pointerCursor: true },
        activate: () => answerQuestion(y - 1, x, number, 'click'),
      }]);
    },
  });

  // ---- a reply finishing while the window is in use ---------------------------------
  // Its title gets a quick sweep of light; when it has scrolled off, the bottom line flares.
  let lastPhase = '';
  let pageFinishUntil = 0;
  function sweepTitle(title, inner, wrap) {
    title.querySelector('.r7-shimmer')?.remove();
    const light = inner.cloneNode(true);
    light.className = `r7-shimmer${wrap ? ' wrap' : ''}`;
    light.style.setProperty('--r7-accent', window.r7Accent || colors.cursor || colors.fg);
    light.setAttribute('aria-hidden', 'true');
    light.querySelector('.r7-title-sel')?.remove();
    title.append(light);
    setTimeout(() => light.remove(), 600);
  }
  function sweepPage() {
    const view = window.r7View;
    if (!view?.active || !pageFinishUntil) return;
    if (!document.hasFocus() || Date.now() > pageFinishUntil) { pageFinishUntil = 0; return; }
    const reply = view.blocks().filter(block => block.kind === 'reply').at(-1);
    if (reply && reply.el.dataset.sealed !== 'true') return;
    pageFinishUntil = 0;
    const title = reply?.el.querySelector('.reply-title');
    const rect = title?.getBoundingClientRect();
    const page = view.root.getBoundingClientRect();
    if (!rect?.height || rect.bottom <= page.top || rect.top >= page.bottom) { flareBottom(); return; }
    sweepTitle(title, title, true);
  }
  window.r7View?.onChange(sweepPage);
  attentionListeners.push((data) => {
    const finished = data.phase === 'waiting' && lastPhase !== 'waiting';
    lastPhase = data.phase;
    if (!finished || !data.completedMs || !document.hasFocus() || Date.now() - data.completedMs > 3000) return;
    if (window.r7View?.active) {
      pageFinishUntil = data.completedMs + 3000;
      sweepPage();
      return;
    }
    const buf = term.buffer.active;
    const title = marks.filter((m) => m.kind === 'title').sort((a, b) => b.marker.line - a.marker.line)[0];
    const inner = title?.el?.querySelector('.r7-title-text');
    const onScreen = title && title.marker.line >= buf.viewportY && title.marker.line < buf.viewportY + term.rows;
    if (!inner || !onScreen) { flareBottom(); return; }
    // A copy of the title's letters over it, showing only a band of light clipped to the
    // glyphs, so the background around them stays dark.
    sweepTitle(title.el, inner, inner.classList.contains('wrap'));
  });

  term.onWriteParsed(() => {
    if (checkQueued || (!pending.length && !marks.length)) return;
    checkQueued = true;
    queueMicrotask(settle);
  });

  // ---- task title above the input box ---------------------------------------------
  // Enlarge the task title above the input box while keeping usage at normal size.
  const TASK_RE = /^\s*(\d+m|✦) \| \S/;
  const taskEl = document.createElement('div');
  taskEl.id = 'r7-task-title';
  screenEl.appendChild(taskEl);
  let taskDrawn = '';
  let taskY = -1;
  // Keep the full title when the terminal row truncates it beside usage.
  let taskFull = null;
  // The title as last drawn, so a new one can decode from it.
  let taskPlain = '';
  let taskDecode = null; // { start, changed: [index in title, settle ms, glyph, glyph ms] }
  let attachedAt = performance.now();
  snapshotListeners.push(() => { attachedAt = performance.now(); });

  // Scramble changed characters and settle them from left to right across redraws.
  const GLYPHS = [...'ABCDEFGHJKLMNPQRSTUVWXYZabdefhkmnqrstxz0123456789#%&*+=<>/\\$@?!'];
  const roll = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  const LOCK_MS = 260; // the white flash as a letter locks in
  const NEAR_MS = 450; // how far ahead of its turn a symbol starts brightening

  function pauseDecode() {
    if (!taskDecode?.frame) return;
    cancelAnimationFrame(taskDecode.frame);
    taskDecode.frame = 0;
  }

  function decodeTitle(old, text) {
    pauseDecode();
    const before = [...old];
    const changed = [];
    [...text].forEach((c, i) => { if (c !== ' ' && c !== before[i]) changed.push(i); });
    if (!changed.length) { taskDecode = null; return; }
    const step = Math.min(90, 1150 / changed.length);
    taskDecode = {
      start: performance.now(),
      changed: changed.map((i, k) => ({ i, settle: 280 + k * step + Math.random() * 220, glyph: roll(), next: 0 })),
    };
    applyDecode();
  }

  function applyDecode() {
    const d = taskDecode;
    const el = taskEl.querySelector('.r7-task-line');
    if (!d || !el) return;
    if (document.hidden || taskEl.style.display === 'none') { pauseDecode(); return; }
    // Split only when the title line is replaced, then keep each changing glyph.
    if (d.el !== el) {
      d.el = el;
      const changed = new Map(d.changed.map((c) => [c.i, c]));
      let g = 0;
      for (const span of el.children) {
        const text = [...span.textContent];
        const nodes = [];
        let run = '';
        for (const char of text) {
          const c = changed.get(g++);
          if (!c) { run += char; continue; }
          if (run) { nodes.push(run); run = ''; }
          c.node = document.createElement('span');
          c.char = char;
          c.view = null;
          nodes.push(c.node);
        }
        if (run) nodes.push(run);
        span.replaceChildren(...nodes);
      }
    }
    const t = performance.now() - d.start;
    let live = false;
    for (const c of d.changed) {
      let char = c.char, className = '', color = '', opacity = '', shadow = '';
      if (t < c.settle + LOCK_MS) {
        live = true;
        if (t >= c.settle) {
          const k = (1 - (t - c.settle) / LOCK_MS) ** 1.5;
          color = `color-mix(in srgb, #fff ${Math.round(k * 100)}%, currentColor)`;
          shadow = `0 0 ${Math.round(4 + 10 * k)}px color-mix(in srgb, var(--r7-accent) ${Math.round(k * 100)}%, transparent)`;
        } else {
          const near = Math.max(0, 1 - (c.settle - t) / NEAR_MS);
          if (t >= c.next) { c.glyph = roll(); c.next = t + (90 - 60 * near) * (0.7 + Math.random() * 0.6); }
          char = c.glyph;
          className = 'r7-scramble';
          opacity = (0.28 + 0.72 * near ** 2).toFixed(2);
          if (near > 0.6) shadow = `0 0 ${Math.round(8 * near)}px var(--r7-accent)`;
        }
      }
      if (!c.node) continue;
      const before = c.view;
      if (!before || before[0] !== char) c.node.textContent = char;
      if (!before || before[1] !== className) c.node.className = className;
      if (!before || before[2] !== color) c.node.style.color = color;
      if (!before || before[3] !== opacity) c.node.style.opacity = opacity;
      if (!before || before[4] !== shadow) c.node.style.textShadow = shadow;
      c.view = [char, className, color, opacity, shadow];
    }
    if (!live) { pauseDecode(); taskDecode = null; return; }
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => { d.frame = 0; if (taskDecode === d) applyDecode(); });
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
    const r = findTaskRow();
    if (r < 0) { taskEl.style.display = 'none'; taskDrawn = ''; taskY = -1; pauseDecode(); return; }
    const y = term.buffer.active.viewportY + r;
    taskY = y;
    const text = rowText(y);
    const x = text.search(/\S/);
    // Usage starts after the title's first run of 2+ spaces.
    const gapAt = text.slice(x).search(/ {2,}\S/);
    const chipX = gapAt < 0 ? -1 : text.slice(x + gapAt).search(/\S/) + x + gapAt;
    let spans = titleSpans(y, x, [], chipX < 0 ? Infinity : chipX);
    const plain = spans.map((s) => s.text).join('');
    if (!plain.endsWith('…')) taskFull = spans;
    else if (taskFull && taskFull.map((s) => s.text).join('').startsWith(plain.slice(0, -1))) spans = taskFull;
    const chip = chipX < 0 ? [] : titleSpans(y, chipX);
    const chipEnd = chipX + chip.reduce((n, s) => n + s.text.length, 0);
    const aboveBlank = r > 0 && !(rowText(y - 1) || '').trim();
    const rowPx = rowHeight();
    const pills = dock.pillWidth?.() || 0;
    const scale = TITLE_SCALE * (window.r7Zoom?.get('title') || 1);
    const key = `${r}|${x}|${chipX}|${aboveBlank}|${term.options.fontSize}|${rowPx}|${term.cols}|${pills}|${scale}|`
      + spans.concat(chip).map((s) => s.color + s.text).join('');
    taskEl.style.display = '';
    if (key === taskDrawn) return;
    taskDrawn = key;
    const cw = cellWidth();
    const rightEdge = pills ? (findBox()?.right ?? term.cols - 1) + 1 : term.cols;
    const width = Math.max(cw, (rightEdge - x) * cw - pills);
    // A few pixels past the row, so tall glyphs like | in the plain row don't peek out.
    const place = (height) => {
      // Bottom-aligned on its row, so the extra height goes up into the blank row above.
      taskEl.style.top = `${(r + 1) * rowPx - height}px`;
      taskEl.style.height = `${height + 3}px`;
      // A zoomed title reaches past its blank row above; the page ends above it (view.js).
      const extra = Math.max(0, Math.ceil(height - rowPx * TITLE_SCALE));
      if (window.r7Zoom && extra !== window.r7Zoom.titleExtra) {
        window.r7Zoom.titleExtra = extra;
        window.dispatchEvent(new Event('r7-view-chrome'));
      }
    };
    taskEl.style.left = `${x * cw}px`;
    taskEl.style.width = `${width}px`;
    place(rowPx * scale);
    const line = (parts, className, scale) => {
      const el = document.createElement('div');
      el.className = className;
      el.style.font = `${term.options.fontSize * scale}px ${term.options.fontFamily}`;
      el.style.lineHeight = `${rowPx * scale}px`;
      // A cut-off title's ellipsis takes the block's own color and weight.
      const tail = parts[parts.length - 1];
      if (tail) el.style.color = tail.color;
      if (tail?.bold) el.style.fontWeight = 'bold';
      for (const s of parts) {
        const span = document.createElement('span');
        span.textContent = s.text;
        span.style.color = s.color;
        if (s.bold) span.style.fontWeight = 'bold';
        el.append(span);
      }
      return el;
    };
    const title = line(spans, 'r7-task-line', scale);
    taskEl.replaceChildren(title);
    const shownText = spans.map((s) => s.text).join('');
    if (shownText !== taskPlain) {
      // Not on the reprint after a reattach, which only redraws the same title.
      if (taskPlain || performance.now() - attachedAt > 1500) decodeTitle(taskPlain, shownText);
      taskPlain = shownText;
    } else applyDecode();
    if (!chip.length || pills) return;
    // The usage keeps its own right edge, two cells clear of the title.
    const right = (term.cols - chipEnd) * cw;
    const room = width - right - 2 * cw - title.scrollWidth;
    const box = document.createElement('div');
    box.className = 'r7-task-usage';
    box.style.right = `${right}px`;
    box.append(line(chip, '', 1));
    taskEl.append(box);
    if (box.scrollWidth <= room) return;
    // Stacked: split at the ` · ` nearest the middle, the first half on the blank row above.
    const chipText = chip.map((s) => s.text).join('');
    let cut = -1;
    for (let i = chipText.indexOf(' · '); i >= 0; i = chipText.indexOf(' · ', i + 1)) {
      if (cut < 0 || Math.abs(i - chipText.length / 2) < Math.abs(cut - chipText.length / 2)) cut = i;
    }
    if (aboveBlank && cut >= 0) {
      const halves = [[], []];
      let at = 0;
      for (const s of chip) {
        const a = s.text.slice(0, Math.max(0, cut - at));
        const b = s.text.slice(Math.max(0, cut + 3 - at));
        if (a) halves[0].push({ ...s, text: a });
        if (b && at + s.text.length > cut + 3) halves[1].push({ ...s, text: b });
        at += s.text.length;
      }
      box.replaceChildren(line(halves[0], '', 1), line(halves[1], '', 1));
      if (box.scrollWidth <= room) {
        place(Math.max(rowPx * 2, rowPx * scale));
        return;
      }
    }
    box.remove();
  }

  // Drawn in the render that shows its row, so it moves with the text. On a timer it
  // moved a frame or two after the row did, and the title showed small on every Ctrl+J.
  // A covered window renders nothing, and redraws everything once it's shown.
  term.onRender(() => { if (harness.on) drawTaskTitle(); });
  window.addEventListener('r7-dock-layout', () => { if (harness.on && !document.hidden) drawTaskTitle(); });
  window.addEventListener('r7-zoom', (e) => { if (e.detail.kind === 'title' && harness.on && !document.hidden) drawTaskTitle(); });

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

  // Live marks belong to a row, not a timer-driven terminal redraw.
  const liveMarks = [];
  const LIVE_KINDS = new Set(['read', 'search', 'edit', 'test', 'build', 'web', 'image', 'app', 'wait', 'think', 'other']);
  window.r7TypingRow = (y) => liveMarks.find((m) => m.kind === 'type' && !m.erased && !m.marker.isDisposed && m.marker.line === y);

  function dropLive(mark) {
    mark.el?.remove();
    mark.marker.dispose();
    const i = liveMarks.indexOf(mark);
    if (i >= 0) liveMarks.splice(i, 1);
  }

  function liveMark(kind, x, parts) {
    const marker = term.registerMarker(0);
    if (!marker) return;
    const old = liveMarks.find((m) => m.kind === kind && m.marker.line === marker.line && m.x === x);
    const work = LIVE_KINDS.has(parts[1]) ? parts[1] : 'other';
    const startedAt = Number(parts[kind === 'spin' ? 1 : 2]) || Date.now();
    const mark = { kind, x, marker, work, startedAt, fresh: true, text: null };
    if (old) {
      if (old.work === work && old.startedAt === startedAt) {
        mark.el = old.el;
        mark.key = old.key;
        old.el = null;
      }
      dropLive(old);
    }
    liveMarks.push(mark);
  }

  // Erase-without-reemit must stop a spinner even when the replacement text is identical.
  term.parser.registerCsiHandler({ final: 'K' }, (params) => {
    const b = term.buffer.active;
    const y = b.baseY + b.cursorY;
    for (const m of liveMarks) {
      if (m.marker.line !== y) continue;
      const mode = params[0] || 0;
      if (mode === 2 || (mode === 0 && b.cursorX <= m.x) || (mode === 1 && b.cursorX >= m.x)) m.erased = true;
    }
    return false;
  });
  term.parser.registerCsiHandler({ final: 'J' }, (params) => {
    const b = term.buffer.active;
    const y = b.baseY + b.cursorY;
    for (const m of liveMarks) {
      const mode = params[0] || 0;
      if (mode >= 2 || (mode === 0 && m.marker.line >= y) || (mode === 1 && m.marker.line <= y)) m.erased = true;
    }
    return false;
  });
  term.onWriteParsed(() => {
    for (const m of liveMarks) {
      if (m.fresh) { m.text = rowText(m.marker.line); m.fresh = false; }
    }
  });

  function placeLive() {
    if (!liveMarks.length) return;
    const b = term.buffer.active;
    const ch = rowHeight(), cw = cellWidth();
    for (const m of [...liveMarks]) {
      if (m.erased || m.marker.isDisposed || (!m.fresh && rowText(m.marker.line) !== m.text)) { dropLive(m); continue; }
      if (m.kind === 'type') {
        if (m.marker.line < b.baseY) dropLive(m);
        continue;
      }
      const row = m.marker.line - b.viewportY;
      m.visible = !document.hidden && b.type === 'normal' && row >= 0 && row < term.rows;
      if (!m.visible) { if (m.el) m.el.hidden = true; continue; }
      if (!m.el) {
        m.el = document.createElement('div');
        m.el.className = `xterm-decoration xterm-decoration-top-layer r7-live-${m.kind}`;
        (screenEl.querySelector('.xterm-decoration-container') || screenEl).append(m.el);
      }
      const el = m.el;
      el.hidden = false;
      el.style.top = `${row * ch}px`;
      el.style.left = `${m.x * cw}px`;
      el.style.height = `${ch}px`;
      el.style.translate = `0 ${window.r7RowMotion?.(row) || 0}px`;
      const line = b.getLine(m.marker.line);
      // Stop at the right-side counter, not at the window's edge.
      const label = line?.translateToString(true, m.x).split(/ {3,}/)[0] || '';
      const width = m.kind === 'spin' ? cw : Math.min(term.cols - m.x, [...label].length) * cw;
      el.style.width = `${width}px`;
      el.style.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
      el.style.lineHeight = `${ch}px`;
      if (m.kind === 'spin') {
        el.style.color = colors.cursor || colors.fg;
        el.style.background = colors.bg;
        // The shared working ring (style.css), turning in CSS: no timer.
        if (!el.firstElementChild) el.replaceChildren(Object.assign(document.createElement('span'), { className: 'r7-ring' }));
        el.firstElementChild.style.setProperty('--tk', `${Math.round(Math.min(cw * 1.6, ch) * .78)}px`);
      } else {
        const key = `${m.work}|${label}`;
        if (m.key !== key) {
          m.key = key;
          el.dataset.work = m.work;
          const light = document.createElement('span');
          light.className = 'r7-live-light';
          light.textContent = label;
          light.style.animationDelay = `${-Math.max(0, Date.now() - m.startedAt)}ms`;
          const pip = document.createElement('i');
          pip.style.animationDelay = light.style.animationDelay;
          el.replaceChildren(light, pip);
        }
      }
    }
  }
  term.onRender(placeLive);
  document.addEventListener('visibilitychange', () => {
    for (const m of liveMarks) if (m.el) m.el.hidden = true;
    if (document.hidden) pauseDecode();
    if (!document.hidden) { taskDrawn = ''; term.refresh(0, term.rows - 1); }
  });
  snapshotListeners.push(() => { for (const m of [...liveMarks]) dropLive(m); });

  let attachmentSnapshot = null;
  let pendingAttachments = null;
  const attachmentElements = new Map();

  function clearAttachments() {
    pendingAttachments?.marker?.dispose();
    attachmentSnapshot?.marker?.dispose();
    pendingAttachments = attachmentSnapshot = null;
    for (const entry of attachmentElements.values()) entry.el.remove();
    attachmentElements.clear();
  }

  function attachmentOsc(payload) {
    let snapshot;
    try { snapshot = JSON.parse(decodeURIComponent(payload)); } catch { clearAttachments(); return; }
    if (!snapshot || snapshot.v !== 1 || !Array.isArray(snapshot.items) || snapshot.items.length > 512 ||
        !snapshot.items.every(item => item && typeof item.id === 'string' && typeof item.path === 'string' &&
          /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(item.path) && typeof item.label === 'string' &&
          item.label.length > 0 && ['row', 'col', 'cols'].every(key => Number.isInteger(item[key])) &&
          item.row >= 0 && item.col >= 0 && item.cols > 0)) {
      clearAttachments();
      return;
    }
    pendingAttachments?.marker?.dispose();
    pendingAttachments = { ...snapshot, x: term.buffer.active.cursorX, marker: term.registerMarker(0) };
  }

  function placeAttachments() {
    if (pendingAttachments) {
      attachmentSnapshot?.marker?.dispose();
      attachmentSnapshot = pendingAttachments;
      pendingAttachments = null;
      const wanted = new Set(attachmentSnapshot.items.map(item => item.id));
      for (const [id, entry] of attachmentElements) {
        if (wanted.has(id)) continue;
        entry.el.remove();
        attachmentElements.delete(id);
      }
    }
    if (!attachmentSnapshot) return;
    const { marker, items, x } = attachmentSnapshot;
    if (!marker || marker.isDisposed) { clearAttachments(); return; }
    const buffer = term.buffer.active;
    const cw = cellWidth(), ch = rowHeight();
    for (const item of items) {
      const col = x + item.col;
      const line = buffer.getLine(marker.line + item.row);
      const row = marker.line + item.row - buffer.viewportY;
      let entry = attachmentElements.get(item.id);
      const matches = buffer.type === 'normal' && row >= 0 && row < term.rows &&
        col + item.cols <= term.cols && line?.translateToString(false, col, col + item.cols) === item.label;
      if (!matches || document.hidden) {
        if (entry) entry.el.hidden = true;
        continue;
      }
      if (entry && entry.path !== item.path) {
        entry.el.remove();
        attachmentElements.delete(item.id);
        entry = null;
      }
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'r7-attachment-preview';
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        el.append(img);
        (screenEl.querySelector('.xterm-decoration-container') || screenEl).append(el);
        entry = { el, path: item.path };
        attachmentElements.set(item.id, entry);
        img.addEventListener('error', () => {
          el.replaceChildren(document.createTextNode('!'));
          el.classList.add('failed');
          r7.log('warn', 'attachments.image_error', { session: cfg.session, path: item.path });
        }, { once: true });
        // One decoded image per visible identity, reused across typing and resize.
        if (r7.fileVersion) {
          const current = entry;
          r7.fileVersion(item.path).catch(() => 0).then(version => {
            if (attachmentElements.get(item.id) === current) {
              img.src = fileUrl(item.path) + (version ? `?v=${version}` : '');
            }
          });
        } else img.src = fileUrl(item.path);
      }
      entry.el.hidden = false;
      const cell = line.getCell(col);
      const bg = cell?.isBgRGB() ? '#' + cell.getBgColor().toString(16).padStart(6, '0') :
        cell?.isBgPalette() ? colors.palette[cell.getBgColor()] || colors.bg : colors.bg;
      entry.el.style.cssText = `left:${col * cw}px;top:${row * ch}px;width:${item.cols * cw}px;height:${ch}px;background:${bg}`;
    }
  }
  term.onRender(placeAttachments);
  snapshotListeners.push(clearAttachments);
  window.addEventListener('r7-clear', () => {
    for (const mark of [...marks]) drop(mark);
    for (const mark of pending.splice(0)) mark.marker?.dispose();
    for (const mark of [...liveMarks]) dropLive(mark);
    clearAttachments();
    for (const answer of hopping.splice(0)) {
      const i = editHooks.indexOf(answer.early);
      if (i >= 0) editHooks.splice(i, 1);
    }
    picked.key = '';
    picked.numbers.clear();
    typedAt = pageFinishUntil = 0;
    pauseDecode();
    taskDecode = taskFull = null;
    taskDrawn = taskPlain = '';
    taskY = -1;
    taskEl.replaceChildren();
    taskEl.style.display = 'none';
  });

  term.parser.registerOscHandler(7321, (data) => {
    const parts = data.split(';');
    const x = term.buffer.active.cursorX;
    if (parts[0] === 'attachments') {
      attachmentOsc(parts.slice(1).join(';'));
    } else if (parts[0] === 'refresh') {
      clearAttachments();
      return false;
    } else if (parts[0] === 'type' || parts[0] === 'spin' || parts[0] === 'live') {
      liveMark(parts[0], x, parts);
    } else if (parts[0] === 'title') {
      pending.push({ kind: 'title', x, marker: term.registerMarker(0) });
    } else if (parts[0] === 'dock') {
      // The dock above the input box is dock.js's: a snapshot (or none) at its first reserved row.
      dock.osc(parts.slice(1).join(';'));
    } else if (parts[0] === 'image' && parts.length >= 4) {
      const rows = Math.max(1, parseInt(parts[1], 10) || 0);
      const cols = Math.max(1, parseInt(parts[2], 10) || 0);
      let path;
      try { path = decodeURIComponent(parts.slice(3).join(';')); } catch { return true; }
      const marker = term.registerMarker(-rows);
      if (marker) pending.push({ kind: 'image', x, rows, cols, path, marker });
    } else if (parts[0] === 'band' || parts[0] === 'thumbs' || parts[0] === 'map') {
      // code band, filmstrips and read maps in the transcript are steps.js's
      return window.handleStepMark ? window.handleStepMark(parts[0], parts.slice(1)) : false;
    } else return false;
    return true;
  });
})();
