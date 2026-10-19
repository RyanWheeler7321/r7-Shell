'use strict';
// Copy only terminal canvases. Row positions and old pixels survive the next xterm
// redraw, so streamed text, the title and the box settle on the same clock.
(() => {
  const FADE_MS = cfg.fadeMs === 0 ? 0 : 300;
  const GLIDE_MS = cfg.textGlideMs === 0 ? 0 : 300;
  const FOLD_MS = 500;
  const TYPE_CPS = 110;
  const QUIET_MS = 600;
  const smooth = (p) => { p = Math.max(0, Math.min(1, p)); return p * p * (3 - 2 * p); };
  const blank = (text) => !text.trim();
  const canvas = document.createElement('canvas');
  canvas.id = 'fade-mask';
  screenEl.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const shot = document.createElement('canvas');
  const shotCtx = shot.getContext('2d');
  let prev = null;
  let states = [];
  let ghosts = [];
  let frame = 0;
  let quietUntil = performance.now() + QUIET_MS;
  let clearedAt = -Infinity;
  let geometry = { w: 0, h: 0, cw: 0, ch: 0, dpr: 1 };
  let overlays = [];
  let offsets = [];
  let viewMode = null;
  const motionEvent = new Event('r7-row-motion');
  window.r7RowMotion = (row) => offsets[Math.max(0, Math.min(term.rows - 1, Math.round(row)))] || 0;

  function cellBg(cell) {
    if (cell.isInverse()) return cell.isFgRGB() ? hex(cell.getFgColor()) : cell.isFgPalette() ? paletteColor(cell.getFgColor()) : colors.fg;
    return cell.isBgRGB() ? hex(cell.getBgColor()) : cell.isBgPalette() ? paletteColor(cell.getBgColor()) : colors.bg;
  }

  function readRows(buf) {
    const rows = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      const text = line?.translateToString(true) || '';
      const cells = [];
      let key = '', cell;
      const last = line ? lastCol(line) : -1;
      for (let x = 0; x <= last; x++) {
        cell = line.getCell(x, cell);
        if (!cell || !cell.getWidth()) continue;
        const chars = cell.getChars() || ' ';
        const color = cellBg(cell);
        const fg = cell.isInverse()
          ? (cell.isBgRGB() ? hex(cell.getBgColor()) : cell.isBgPalette() ? paletteColor(cell.getBgColor()) : colors.bg)
          : (cell.isFgRGB() ? hex(cell.getFgColor()) : cell.isFgPalette() ? paletteColor(cell.getFgColor()) : colors.fg);
        cells.push({ x, w: cell.getWidth(), chars, color, fg, bold: !!cell.isBold(), italic: !!cell.isItalic(), dim: !!cell.isDim(), invisible: !!cell.isInvisible(), underline: !!cell.isUnderline() });
        key += `${chars}:${cell.getFgColor()}:${cell.getBgColor()}:${cell.isBold()}:${cell.isItalic()}:${cell.isDim()}:${cell.isInverse()}|`;
      }
      const typed = window.r7TypingRow?.(buf.viewportY + y);
      rows.push({ text, key, cells, type: !!typed, typeX: typed?.x || 0 });
    }
    return rows;
  }

  function measure() {
    const dpr = window.devicePixelRatio || 1;
    const w = screenEl.clientWidth, h = screenEl.clientHeight;
    geometry = { w, h, dpr, cw: w / term.cols, ch: h / term.rows };
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    overlays = [...screenEl.querySelectorAll('.xterm-decoration, #r7-task-title, #glide-cursor, #box-selection')].map((el) => ({
      el, row: el.id === 'glide-cursor' || el.id === 'box-selection'
        ? term.buffer.active.cursorY + term.buffer.active.baseY - term.buffer.active.viewportY
        : Math.max(0, Math.round(parseFloat(el.style.top || '0') / geometry.ch)),
    }));
  }

  function snapshot() {
    // UI effect canvases must never feed back into a terminal copy.
    const layers = [...screenEl.querySelectorAll('canvas')].filter((c) => !c.id && c.width && c.height);
    if (!layers.length || renderer === 'dom') {
      // The software renderer has DOM rows rather than a glyph canvas.
      const { w, h, cw, ch, dpr } = geometry;
      shot.width = Math.round(w * dpr); shot.height = Math.round(h * dpr);
      shotCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      shotCtx.fillStyle = colors.bg;
      shotCtx.fillRect(0, 0, w, h);
      shotCtx.textBaseline = 'middle';
      for (let y = 0; y < (prev?.rows.length || 0); y++) {
        for (const c of prev.rows[y].cells) {
          shotCtx.fillStyle = c.color;
          shotCtx.fillRect(c.x * cw, y * ch, c.w * cw, ch);
          if (c.invisible) continue;
          shotCtx.font = `${c.italic ? 'italic ' : ''}${c.bold ? 'bold ' : ''}${term.options.fontSize}px ${term.options.fontFamily}`;
          shotCtx.fillStyle = c.fg;
          shotCtx.globalAlpha = c.dim ? 0.5 : 1;
          shotCtx.fillText(c.chars, c.x * cw, (y + 0.5) * ch);
          if (c.underline) shotCtx.fillRect(c.x * cw, (y + 0.85) * ch, c.w * cw, 1);
          shotCtx.globalAlpha = 1;
        }
      }
      shotCtx.setTransform(1, 0, 0, 1, 0, 0);
      for (const layer of layers) shotCtx.drawImage(layer, 0, 0, shot.width, shot.height);
      return true;
    }
    const base = layers[0];
    if (shot.width !== base.width || shot.height !== base.height) { shot.width = base.width; shot.height = base.height; }
    shotCtx.clearRect(0, 0, shot.width, shot.height);
    for (const layer of layers) shotCtx.drawImage(layer, 0, 0, shot.width, shot.height);
    return true;
  }

  function copyRow(row) {
    if (!shot.width || row < 0 || row >= term.rows) return null;
    const copy = document.createElement('canvas');
    copy.width = shot.width;
    copy.height = Math.ceil(shot.height / term.rows);
    copy.getContext('2d').drawImage(shot, 0, row * shot.height / term.rows, shot.width, shot.height / term.rows, 0, 0, copy.width, copy.height);
    return copy;
  }

  function progress(state, now) { return smooth((now - state.start) / state.ms); }
  function offset(state, now) { return state?.from ? state.from * (1 - progress(state, now)) : 0; }
  // The concepts reveal in 30fps steps (about 4 glyphs a step), not a glyph per display frame.
  const TYPE_STEP_MS = 1000 / 30;
  function frontier(type, now) {
    const t = Math.floor(Math.max(0, now - type.start) / TYPE_STEP_MS) * TYPE_STEP_MS;
    return Math.min(type.end, type.from + Math.floor(t * TYPE_CPS / 1000));
  }

  function matchRows(old, rows, stop) {
    const source = new Array(rows.length).fill(-1);
    const used = new Set();
    let best = 0, bestScore = -1;
    for (let k = -old.stop; k <= stop; k++) {
      let score = 0;
      for (let i = Math.max(0, -k); i < stop && i + k < old.stop; i++) {
        if (!blank(rows[i].text) && rows[i].text === old.rows[i + k].text) score++;
      }
      if (score > bestScore || (score === bestScore && Math.abs(k) < Math.abs(best))) { best = k; bestScore = score; }
    }
    for (let i = 0; i < stop; i++) {
      if (blank(rows[i].text)) continue;
      let found = -1;
      for (let j = 0; j < old.stop; j++) {
        if (used.has(j) || old.rows[j].text !== rows[i].text) continue;
        if (found < 0 || Math.abs(j - i - best) < Math.abs(found - i - best)) found = j;
      }
      if (found >= 0) { source[i] = found; used.add(found); }
    }
    // The box and title follow their own anchor, not the transcript's scroll shift.
    for (let i = stop; i < rows.length; i++) {
      const j = i + old.stop - stop;
      if (j >= old.stop && j < old.rows.length) { source[i] = j; used.add(j); }
    }
    for (let i = 0; i < stop; i++) {
      if (source[i] >= 0) continue;
      let shift = best;
      for (let n = i + 1; n < stop; n++) if (source[n] >= 0) { shift = source[n] - n; break; }
      let j = i + shift;
      // A folded header replaces its header, not the last disappearing child.
      if (/[├└]─/.test(old.rows[j]?.text || '') && !/[├└]─/.test(rows[i].text)
          && i < old.stop && !used.has(i) && !/[├└]─/.test(old.rows[i].text)) j = i;
      if (j >= 0 && j < old.stop && !used.has(j)) { source[i] = j; used.add(j); }
    }
    return { source, used, best };
  }

  // With the page drawing the transcript, the terminal shows only the bottom chrome. Its
  // rows (title, status, box) change in the same frame: no glide, no character fade.
  // Returns true while the page is active; clears any running motion once per change.
  function viewActive() {
    const view = document.body.classList.contains('r7-view') || !!window.r7View?.active;
    if (view === viewMode) return view;
    viewMode = view;
    reset();
    r7.log('info', 'fade.mode', { session: cfg.session, view });
    return view;
  }

  function scan() {
    if (document.hidden) return;
    if (viewActive()) return;
    const b = term.buffer.active;
    if (b.type !== 'normal' || b.viewportY !== b.baseY || scroll.frame || scroll.shifted) { reset(); return; }
    const now = performance.now();
    const box = findBox();
    const stop = box ? Math.max(0, box.top - 1) : term.rows;
    const rows = readRows(b);
    measure();
    const old = prev;
    if (old && now - clearedAt < 300 && rows.slice(0, stop).filter((r) => !blank(r.text)).length < old.rows.slice(0, old.stop).filter((r) => !blank(r.text)).length * 0.3) return;
    prev = { rows, stop };
    // A moving box edge (a new input line) is a layout change, not a fold: settle at once.
    if (!old || now < quietUntil || catchingUp || shownQuiet || old.stop !== stop) {
      states = []; ghosts = []; snapshot(); draw(); return;
    }
    if (old.stop === stop && rows.every((r, i) => r.key === old.rows[i]?.key && r.type === old.rows[i]?.type)) {
      snapshot();
      if (states.length || ghosts.length) draw();
      return;
    }
    const { source, used, best } = matchRows(old, rows, stop);
    const removed = GLIDE_MS ? old.rows.map((r, i) => ({ ...r, row: i })).filter((r) => r.row >= Math.max(0, best) && r.row < old.stop && !used.has(r.row) && /[├└]─/.test(r.text)) : [];
    const folding = removed.length > 0;
    const ms = folding ? FOLD_MS : GLIDE_MS;
    const next = new Array(rows.length);
    let stagger = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], j = source[i], was = old.rows[j];
      const previous = states[j];
      const changed = !was || row.key !== was.key;
      const moved = j >= 0 && i !== j;
      const from = moved ? j - i + offset(previous, now) : offset(previous, now);
      // An unrelated streamed row must not restart every other row's glide.
      const state = !moved && previous ? { ...previous } : { start: now, ms: ms || 1, from: GLIDE_MS ? from : 0 };
      if (moved && previous) {
        state.type = previous.type;
        state.old = previous.old;
        state.changeAt = previous.changeAt;
        state.arrival = previous.arrival;
      }
      if (!row.type) state.type = null;
      if (i < stop && changed && !blank(row.text)) {
        const arrival = !was || blank(was.text);
        if (row.type) {
          let common = 0;
          if (was) while (common < row.cells.length && row.cells[common]?.chars === was.cells[common]?.chars) common++;
          const first = Math.max(0, row.cells.findIndex((c) => c.x >= row.typeX && c.chars.trim()));
          const at = Math.max(first, previous?.type ? Math.min(common, frontier(previous.type, now)) : common);
          state.type = { from: at, end: row.cells.length, start: now + (at > first ? 0 : Math.min(180, stagger++ * 35)) };
          state.old = null;
        } else if (FADE_MS) {
          state.type = null;
          state.old = arrival ? null : copyRow(j);
          state.changeAt = now;
        }
        if (arrival && GLIDE_MS) { state.arrival = now; state.changeAt = now; }
      }
      // Editor keystrokes remain immediate; only the editor's position glides.
      if (i >= stop) { state.type = null; state.old = null; state.changeAt = undefined; state.arrival = undefined; }
      next[i] = state;
    }
    ghosts = ghosts.filter((g) => now - g.start < FOLD_MS);
    for (const r of removed) {
      const image = copyRow(r.row);
      if (image) ghosts.push({ image, row: r.row + offset(states[r.row], now), start: now });
    }
    states = next;
    snapshot();
    if (window.__fadeLog) window.__fadeLog.push({ t: Math.round(now), stop, best, fold: removed.length, changed: rows.flatMap((r, i) => r.key !== old.rows[i]?.key ? [i] : []) });
    draw();
  }

  function moveOverlays(now = performance.now()) {
    for (const { el, row } of overlays) {
      const off = window.r7RowMotion(row);
      // Individual translate composes with the cursor's own x/y transform.
      el.style.translate = off ? `0 ${off}px` : '';
      if (el.classList.contains('xterm-decoration')) el.style.transform = '';
      if (el.classList.contains('r7-live-live') || el.classList.contains('r7-live-spin')) {
        const start = states[row]?.arrival;
        const grow = start === undefined || !GLIDE_MS ? 1 : smooth((now - start) / GLIDE_MS);
        el.style.transformOrigin = 'bottom';
        el.style.scale = grow < 1 ? `1 ${grow}` : '';
        el.style.opacity = grow < 1 ? String(grow) : '';
      }
      if (el.classList.contains('r7-live-live') || el.classList.contains('r7-title')) {
        const s = states[row];
        const cells = prev?.rows[row]?.cells;
        const edge = s?.type && cells?.[Math.floor(frontier(s.type, now))];
        const left = parseFloat(el.style.left) || 0;
        const width = parseFloat(el.style.width) || 0;
        const scale = el.classList.contains('r7-title') ? 1.3 : 1;
        const right = edge ? Math.max(0, width - (edge.x * geometry.cw - left) * scale) : 0;
        el.style.clipPath = right ? `inset(0 ${right}px 0 0)` : '';
      }
    }
    window.dispatchEvent(motionEvent);
  }

  function draw() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (document.hidden) { reset(); return; }
    const now = performance.now();
    const { w, h, cw, ch, dpr } = geometry;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    offsets = states.map((s) => offset(s, now) * ch);
    const moving = offsets.some((off) => Math.abs(off) > 0.01);
    const growing = states.some((s) => s.arrival !== undefined && now - s.arrival < GLIDE_MS);
    const changing = states.some((s) => s.changeAt !== undefined && now - s.changeAt < FADE_MS);
    ghosts = ghosts.filter((g) => now - g.start < FOLD_MS);
    const copied = shot.width > 0 && (moving || growing || changing || ghosts.length);
    if (copied) {
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, w, h);
      const srcH = shot.height / term.rows;
      for (let i = 0; i < term.rows; i++) {
        const s = states[i];
        const p = s?.changeAt === undefined || !FADE_MS ? 1 : smooth((now - s.changeAt) / FADE_MS);
        const grow = s?.arrival === undefined || !GLIDE_MS ? 1 : smooth((now - s.arrival) / GLIDE_MS);
        const y = i * ch + (offsets[i] || 0) + ch * (1 - grow);
        if (s?.old && p < 1) {
          ctx.globalAlpha = 1 - p;
          ctx.drawImage(s.old, 0, y - ch * 0.12 * p, w, ch);
        }
        ctx.globalAlpha = s?.type ? grow : p * grow;
        if (grow > 0) ctx.drawImage(shot, 0, i * srcH, shot.width, srcH, 0, y, w, ch * grow);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, (prev?.stop ?? term.rows) * ch);
      ctx.clip();
      for (const g of ghosts) {
        const p = smooth((now - g.start) / FOLD_MS);
        ctx.globalAlpha = (1 - p) * 0.7;
        ctx.drawImage(g.image, 0, g.row * ch - p * ch * 0.5, w, ch * (1 - p));
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    let typing = false;
    for (let i = 0; i < states.length; i++) {
      const s = states[i], row = prev?.rows[i];
      if (!s.type || !row) continue;
      const edge = frontier(s.type, now);
      if (edge >= s.type.end) { s.type = null; continue; }
      typing = true;
      const n = Math.floor(edge);
      const grow = s.arrival === undefined || !GLIDE_MS ? 1 : smooth((now - s.arrival) / GLIDE_MS);
      const y = i * ch + (offsets[i] || 0) + ch * (1 - grow);
      for (let k = n; k < row.cells.length; k++) {
        const c = row.cells[k];
        ctx.fillStyle = c.color;
        ctx.fillRect(c.x * cw, y, c.w * cw + 0.5, ch * grow);
      }
      if (now >= s.type.start && row.cells[n]) {
        ctx.fillStyle = colors.cursor || colors.fg;
        ctx.fillRect(row.cells[n].x * cw, y + ch * grow * 0.13, Math.max(2, Math.round(cw * 0.22)), ch * grow * 0.74);  // concept caret: 2px on a 9px cell
      }
    }
    ctx.restore();
    if (moving || growing || changing || ghosts.length || typing) frame = requestAnimationFrame(draw);
    else { states = []; offsets = []; }
    moveOverlays(now);
  }

  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    prev = null; states = []; ghosts = []; offsets = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    moveOverlays();
  }
  function hush() { quietUntil = performance.now() + QUIET_MS; reset(); }
  window.addEventListener('r7-clear', hush);
  term.onRender(scan);
  term.onResize(hush);
  snapshotListeners.push(hush);
  document.addEventListener('visibilitychange', hush);
  term.parser.registerCsiHandler({ final: 'J' }, (params) => {
    if (params[0] >= 2) clearedAt = performance.now();
    return false;
  });
})();
