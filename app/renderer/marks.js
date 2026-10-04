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
          term.focus();
          r7.log('info', 'marks.question', { session: cfg.session, marker: m[2] });
          // The number hops into the box and is typed when it lands, or at once if a
          // key comes first, so it always goes ahead of what you type next.
          const buf = term.buffer.active;
          const box = findBox();
          const from = { x, y: y - 1 - buf.viewportY };
          const to = box && buf.cursorY > box.top && buf.cursorY <= box.bottom
            ? { x: buf.cursorX, y: buf.cursorY } : box ? { x: box.left + 3, y: box.top + 1 } : null;
          if (!to || from.y < 0 || from.y >= term.rows) { sendInput(paste); return; }
          let sent = false;
          const send = () => {
            if (sent) return;
            sent = true;
            // Taken out after this key's own pass through the hooks.
            setTimeout(() => editHooks.splice(editHooks.indexOf(early), 1));
            sendInput(paste);
          };
          const early = () => { if (!sent) send(); return false; };
          editHooks.unshift(early);
          motion.hop(`${number}:`, from, to, ASK_COLOR, send);
        },
      }]);
    },
  });

  // ---- a reply finishing while the window is in use ---------------------------------
  // Its title gets a quick sweep of light; when it has scrolled off, the bottom line flares.
  let lastPhase = '';
  attentionListeners.push((data) => {
    const finished = data.phase === 'waiting' && lastPhase !== 'waiting';
    lastPhase = data.phase;
    if (!finished || !data.completedMs || !document.hasFocus() || Date.now() - data.completedMs > 3000) return;
    const buf = term.buffer.active;
    const title = marks.filter((m) => m.kind === 'title').sort((a, b) => b.marker.line - a.marker.line)[0];
    const inner = title?.el?.querySelector('.r7-title-text');
    const onScreen = title && title.marker.line >= buf.viewportY && title.marker.line < buf.viewportY + term.rows;
    if (!inner || !onScreen) { flareBottom(); return; }
    // A copy of the title's letters over it, showing only a band of light clipped to the
    // glyphs, so the background around them stays dark.
    title.el.querySelector('.r7-shimmer')?.remove();
    const light = inner.cloneNode(true);
    light.className = `r7-shimmer${inner.classList.contains('wrap') ? ' wrap' : ''}`;
    light.querySelector('.r7-title-sel')?.remove();
    title.el.append(light);
    setTimeout(() => light.remove(), 600);
  });

  term.onWriteParsed(() => {
    if (checkQueued || (!pending.length && !marks.length)) return;
    checkQueued = true;
    queueMicrotask(settle);
  });

  // ---- task title above the input box ---------------------------------------------
  // r7-Harness's `5m | Task title` row sits right above the input box's top border. It's
  // drawn TITLE_SCALE like reply titles. When the box's top border is too narrow, the usage
  // can sit at this row's right; it stays normal size there, stacks its two halves when
  // the title needs the room, and goes away when even that doesn't fit.
  const TASK_RE = /^\s*(\d+m|✦) \| \S/;
  const taskEl = document.createElement('div');
  taskEl.id = 'r7-task-title';
  screenEl.appendChild(taskEl);
  let taskDrawn = '';
  let taskY = -1;
  // The last task title seen whole: r7-Harness cuts it to fit beside the usage at normal size,
  // and the room this layout frees can show it whole again.
  let taskFull = null;
  // The title as last drawn, so a new one can decode from it.
  let taskPlain = '';
  let taskDecode = null; // { start, changed: [index in title, settle ms, glyph, glyph ms] }
  let attachedAt = performance.now();
  snapshotListeners.push(() => { attachedAt = performance.now(); });

  // Decrypting: every character that changed turns to dim scrambled symbols in the accent
  // colour at once and keeps re-rolling; a bright front runs left to right, each symbol
  // brightening and rolling faster as its turn nears, then locking in with a white flash
  // that cools to its own colour. About 1.6s for a full title; unchanged characters (the
  // shared start, a kept minute count) stay. It survives r7-Harness redrawing the same title
  // meanwhile (drawTaskTitle reapplies it to the new line).
  const GLYPHS = [...'ABCDEFGHJKLMNPQRSTUVWXYZabdefhkmnqrstxz0123456789#%&*+=<>/\\$@?!'];
  const roll = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  const LOCK_MS = 260; // the white flash as a letter locks in
  const NEAR_MS = 450; // how far ahead of its turn a symbol starts brightening

  function decodeTitle(old, text) {
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
    const t = performance.now() - d.start;
    const live = new Map(); // index -> { glyph, near } while scrambled, { lock } while flashing
    for (const c of d.changed) {
      if (t >= c.settle + LOCK_MS) continue;
      if (t >= c.settle) { live.set(c.i, { lock: 1 - (t - c.settle) / LOCK_MS }); continue; }
      const near = Math.max(0, 1 - (c.settle - t) / NEAR_MS);
      if (t >= c.next) { c.glyph = roll(); c.next = t + (90 - 60 * near) * (0.7 + Math.random() * 0.6); }
      live.set(c.i, { glyph: c.glyph, near });
    }
    let g = 0;
    for (const span of el.children) {
      const text = [...(span.dataset.text ??= span.textContent)];
      const nodes = [];
      let run = '';
      text.forEach((c, i) => {
        const s = live.get(g + i);
        if (!s) { run += c; return; }
        if (run) { nodes.push(run); run = ''; }
        const x = document.createElement('span');
        if (s.lock !== undefined) {
          const k = s.lock ** 1.5;
          x.textContent = c;
          x.style.color = `color-mix(in srgb, #fff ${Math.round(k * 100)}%, currentColor)`;
          x.style.textShadow = `0 0 ${Math.round(4 + 10 * k)}px color-mix(in srgb, var(--r7-accent) ${Math.round(k * 100)}%, transparent)`;
        } else {
          x.className = 'r7-scramble';
          x.textContent = s.glyph;
          x.style.opacity = (0.28 + 0.72 * s.near ** 2).toFixed(2);
          if (s.near > 0.6) x.style.textShadow = `0 0 ${Math.round(8 * s.near)}px var(--r7-accent)`;
        }
        nodes.push(x);
      });
      if (run) nodes.push(run);
      span.replaceChildren(...nodes);
      g += text.length;
    }
    if (!live.size) { taskDecode = null; return; }
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
    if (r < 0) { taskEl.style.display = 'none'; taskDrawn = ''; taskY = -1; return; }
    const y = term.buffer.active.viewportY + r;
    taskY = y;
    const text = rowText(y);
    const x = text.search(/\S/);
    // The usage, if it's on this row, starts after the title's first run of 2+ spaces.
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
    const key = `${r}|${x}|${chipX}|${aboveBlank}|${term.options.fontSize}|${rowPx}|${term.cols}|`
      + spans.concat(chip).map((s) => s.color + s.text).join('');
    taskEl.style.display = '';
    if (key === taskDrawn) return;
    taskDrawn = key;
    const cw = cellWidth();
    const width = (term.cols - x) * cw;
    // A few pixels past the row, so tall glyphs like | in the plain row don't peek out.
    const place = (height) => {
      // Bottom-aligned on its row, so the extra height goes up into the blank row above.
      taskEl.style.top = `${(r + 1) * rowPx - height}px`;
      taskEl.style.height = `${height + 3}px`;
    };
    taskEl.style.left = `${x * cw}px`;
    taskEl.style.width = `${width}px`;
    place(rowPx * TITLE_SCALE);
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
    const title = line(spans, 'r7-task-line', TITLE_SCALE);
    taskEl.replaceChildren(title);
    const shownText = spans.map((s) => s.text).join('');
    if (shownText !== taskPlain) {
      // Not on the reprint after a reattach, which only redraws the same title.
      if (taskPlain || performance.now() - attachedAt > 1500) decodeTitle(taskPlain, shownText);
      taskPlain = shownText;
    } else applyDecode();
    if (!chip.length) return;
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
        place(Math.max(rowPx * 2, rowPx * TITLE_SCALE));
        return;
      }
    }
    box.remove();
  }

  // Drawn in the render that shows its row, so it moves with the text. On a timer it
  // moved a frame or two after the row did, and the title showed small on every Ctrl+J.
  // A covered window renders nothing, and redraws everything once it's shown.
  term.onRender(() => { if (harness.on) drawTaskTitle(); });

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
