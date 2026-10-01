'use strict';
// New text fades in and moved text glides. Each frame is compared with the one before,
// row by row: a row found again higher or lower on the screen glides from where it was
// (GLIDE_MS), and characters that weren't there before are covered by their cell's
// background, which fades out over cfg.fadeMs. Characters start one after another in
// reading order like a typewriter, STEP_MS apart while text streams in, squeezed into a
// quick sweep when a whole block arrives at once, never more than MAX_LAG_MS behind. Each
// sweep speeds up a little as it goes (ACCEL: its last steps are that much faster).
// The input box and task title, full-screen programs, the reprints after a resize or
// reattach and the output a hidden window catches up on (renderer.js) do neither.

(() => {
  const FADE_MS = cfg.fadeMs ?? 150;
  const GLIDE_MS = 120;
  if (!FADE_MS && !GLIDE_MS) return;
  const STEP_MS = 6;
  const SPREAD_MS = 120;
  const ACCEL = 1.2;
  const QUIET_MS = 600;
  // Streamed text can run at most this far behind; past it, new text joins the sweep's tail.
  const MAX_LAG_MS = 150;

  const canvas = document.createElement('canvas');
  canvas.id = 'fade-mask';
  screenEl.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  // A copy of the terminal's own canvases, taken right after each render, to draw rows
  // from while they glide.
  const shot = document.createElement('canvas');
  const shotCtx = shot.getContext('2d');

  let prev = null; // the last frame: { rows: [{ text, line, filled }], stop }
  let fades = []; // { row, x, w, color, start }
  let glide = null; // { start, stop, from: rows away from rest when the glide started }
  let quietUntil = performance.now() + QUIET_MS;
  let hushAt = 0;
  let clearedAt = -1e9;
  let frame = 0;
  let clearTimer = 0;
  let lastStart = 0;
  let lastKeyAt = -1e9;
  document.addEventListener('keydown', () => { lastKeyAt = performance.now(); }, true);

  // Log (app.jsonl): `fade.summary` every 5s while text is fading or gliding. `scans` and
  // `scanMs` cover every render since the last summary (`spanMs`), idle stretches included;
  // `typingBatches` counts fades that began within 400ms of a key press.
  const EMPTY = { batches: 0, cells: 0, maxLag: 0, glides: 0, maxGlide: 0, typing: 0, scans: 0, scanMs: 0, maxScanMs: 0, since: 0, spanFrom: 0 };
  const tally = { ...EMPTY };
  let tallyTimer = 0;
  function note(now) {
    if (!tally.since) {
      tally.since = now;
      tallyTimer = setTimeout(() => note(tally.since + 5000), 5000);
    }
    if (now - tally.since < 5000) return;
    clearTimeout(tallyTimer);
    r7.log('info', 'fade.summary', {
      session: cfg.session, batches: tally.batches, cells: tally.cells, maxLagMs: tally.maxLag,
      glides: tally.glides, maxGlideRows: tally.maxGlide, typingBatches: tally.typing,
      scans: tally.scans, scanMs: Math.round(tally.scanMs), maxScanMs: +tally.maxScanMs.toFixed(2),
      spanMs: Math.round(now - tally.spanFrom),
    });
    Object.assign(tally, EMPTY, { spanFrom: now });
  }
  function logBatch(found, lag, now) {
    tally.batches++;
    tally.cells += found.length;
    tally.maxLag = Math.max(tally.maxLag, Math.round(lag));
    if (now - lastKeyAt < 400) tally.typing++;
    note(now);
  }

  // Rows that grew or shrank at the end (streaming, word wrap) aren't different; a row
  // that shares under 60% of its characters, column for column, is.
  function mostlyDifferent(a, b) {
    if (a.startsWith(b) || b.startsWith(a)) return false;
    const n = Math.min(a.length, b.length);
    let same = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
    return same < n * 0.6;
  }

  function cellBg(cell) {
    if (cell.isInverse()) {
      if (cell.isFgRGB()) return hex(cell.getFgColor());
      if (cell.isFgPalette()) return paletteColor(cell.getFgColor());
      return colors.fg;
    }
    if (cell.isBgRGB()) return hex(cell.getBgColor());
    if (cell.isBgPalette()) return paletteColor(cell.getBgColor());
    return colors.bg;
  }

  // Which cells hold a character, read now: xterm reuses its line objects, so a row
  // kept from the last frame can't be read again later. A row whose text was on screen
  // last frame, anywhere (it scrolled), reuses what was read then.
  function readRows(buf) {
    const known = new Map();
    if (prev) for (const row of prev.rows) known.set(row.text, row.filled);
    const rows = [];
    for (let r = 0; r < term.rows; r++) {
      const line = buf.getLine(buf.viewportY + r);
      const text = line ? line.translateToString(true) : '';
      rows.push({ text, line, filled: known.get(text) || filledOf(line) });
    }
    return rows;
  }

  function filledOf(line) {
    const filled = new Uint8Array(term.cols);
    if (!line) return filled;
    let cell;
    for (let x = 0; x < term.cols; x++) {
      cell = line.getCell(x, cell);
      if (!cell) break;
      const ch = cell.getChars();
      if (ch && ch !== ' ') filled[x] = 1;
    }
    return filled;
  }

  // Rows from the input box's top border down (and the task title row above it) never fade
  // or glide.
  function boxTop(rows) {
    let bottom = -1;
    for (let r = rows.length - 1; r >= 0; r--) {
      const text = rows[r].text;
      if (bottom < 0 && /^╰/.test(text)) bottom = r;
      else if (bottom >= 0 && /^╭/.test(text)) return r - 1;
    }
    return rows.length;
  }

  const blank = (text) => !text.trim();
  const countText = (rows, stop) => { let n = 0; for (let i = 0; i < stop; i++) if (!blank(rows[i].text)) n++; return n; };

  // Where each row of this frame was in the last one, as rows moved (+ = it came up from
  // below). The whole screen's most common shift wins; rows that match elsewhere keep their
  // own; new rows move with the nearest row above them.
  function matchRows(old, rows, stop) {
    let best = 0;
    let bestScore = -1;
    for (let k = -old.stop; k <= old.stop; k++) {
      let score = 0;
      for (let i = Math.max(0, -k); i < stop && i + k < old.stop; i++) {
        const t = rows[i].text;
        if (t === old.rows[i + k].text && !blank(t)) score++;
      }
      if (score > bestScore || (score === bestScore && Math.abs(k) < Math.abs(best))) { best = k; bestScore = score; }
    }
    const where = new Map();
    for (let j = 0; j < old.stop; j++) {
      const t = old.rows[j].text;
      if (blank(t)) continue;
      if (!where.has(t)) where.set(t, []);
      where.get(t).push(j);
    }
    const shift = new Array(stop).fill(null);
    const exact = new Array(stop).fill(false);
    for (let i = 0; i < stop; i++) {
      const t = rows[i].text;
      if (blank(t)) continue;
      if (old.rows[i + best]?.text === t && i + best < old.stop) { shift[i] = best; exact[i] = true; continue; }
      const spots = where.get(t);
      if (!spots) continue;
      let j = spots[0];
      for (const s of spots) if (Math.abs(s - i - best) < Math.abs(j - i - best)) j = s;
      shift[i] = j - i;
      exact[i] = true;
    }
    let carry = null;
    for (let i = 0; i < stop; i++) {
      if (shift[i] !== null) carry = shift[i];
      else shift[i] = carry;
    }
    carry = best;
    for (let i = stop - 1; i >= 0; i--) {
      if (shift[i] !== null && exact[i]) carry = shift[i];
      if (shift[i] === null) shift[i] = carry;
    }
    return { shift, exact, best };
  }

  function offsetAt(g, row, now) {
    if (!g || row < 0 || row >= g.from.length) return 0;
    const p = Math.min(1, (now - g.start) / GLIDE_MS);
    return g.from[row] * (1 - p) ** 3;
  }

  const zOf = new WeakMap();
  function layerZ(c) {
    if (!zOf.has(c)) zOf.set(c, Number(getComputedStyle(c).zIndex) || 0);
    return zOf.get(c);
  }

  // Copy the terminal's canvases (text, then links and pictures above it) while this render
  // is still on them.
  function snapshot() {
    const layers = [...screenEl.querySelectorAll('canvas')].filter((c) => c !== canvas && c.width && c.height);
    layers.sort((a, b) => layerZ(a) - layerZ(b));
    if (!layers.length) return false;
    const base = layers[0];
    if (shot.width !== base.width || shot.height !== base.height) {
      shot.width = base.width;
      shot.height = base.height;
    }
    shotCtx.clearRect(0, 0, shot.width, shot.height);
    for (const layer of layers) shotCtx.drawImage(layer, 0, 0, shot.width, shot.height);
    return true;
  }

  function scan() {
    const t0 = performance.now();
    scanOnce();
    const ms = performance.now() - t0;
    tally.scans++;
    tally.scanMs += ms;
    if (ms > tally.maxScanMs) tally.maxScanMs = ms;
  }

  function scanOnce() {
    const buf = term.buffer.active;
    if (buf.type !== 'normal' || buf.viewportY !== buf.baseY) {
      prev = null;
      glide = null;
      return;
    }
    const now = performance.now();
    const rows = readRows(buf);
    const stop = boxTop(rows);
    const unchanged = prev && prev.stop === stop && rows.every((r, i) => r.text === prev.rows[i].text);
    if (unchanged) {
      if (glide) snapshot();
      return;
    }
    const quiet = now < quietUntil || catchingUp;
    // A reprint can take longer than QUIET_MS to arrive; the quiet lasts until it's done.
    if (now < quietUntil) quietUntil = Math.min(Math.max(quietUntil, now + 200), hushAt + 2000);
    // A cleared screen whose reprint comes a frame later: compare the reprint with the
    // screen before the clear.
    if (prev && now - clearedAt < 300 && countText(rows, stop) < countText(prev.rows, prev.stop) * 0.3) return;
    const old = prev;
    prev = { rows, stop };
    if (!old || quiet) {
      fades = [];
      glide = null;
      draw();
      return;
    }

    const { shift, exact } = matchRows(old, rows, stop);

    // Fades still running follow their rows; the rows now at the box stop fading.
    const newRow = new Map();
    for (let i = 0; i < stop; i++) if (!newRow.has(i + shift[i])) newRow.set(i + shift[i], i);
    fades = fades.filter((f) => {
      const row = newRow.get(f.row);
      if (row === undefined) return false;
      f.row = row;
      return true;
    });

    // Rows that moved glide from where they were, carrying on from a glide under way.
    if (GLIDE_MS) {
      let moved = 0;
      const from = new Float32Array(stop);
      for (let i = 0; i < stop; i++) {
        from[i] = Math.max(-term.rows, Math.min(term.rows, shift[i] + offsetAt(glide, i + shift[i], now)));
        if (shift[i] && !blank(rows[i].text)) moved = Math.max(moved, Math.abs(shift[i]));
      }
      if (moved || glide) {
        glide = snapshot() && from.some((v) => Math.abs(v) > 0.02) ? { start: now, stop, from } : null;
        if (moved && glide) { tally.glides++; tally.maxGlide = Math.max(tally.maxGlide, moved); note(now); }
      }
    }

    // Characters that weren't on their row before fade in.
    const found = [];
    if (FADE_MS) {
      let cell;
      for (let i = 0; i < stop; i++) {
        if (exact[i] || blank(rows[i].text)) continue;
        const was = old.rows[i + shift[i]];
        const oldFilled = was && !mostlyDifferent(was.text, rows[i].text) ? was.filled : null;
        const filled = rows[i].filled;
        for (let x = 0; x < term.cols; x++) {
          if (!filled[x] || oldFilled?.[x]) continue;
          cell = rows[i].line.getCell(x, cell);
          found.push({ row: i, x, w: cell.getWidth() || 1, color: cellBg(cell) });
        }
      }
    }
    if (found.length) {
      // One sweep in reading order across batches: each character starts after the one
      // before it, STEP_MS apart, closer together when a batch is big or the sweep is behind.
      const lag = Math.max(0, lastStart - now);
      const n = found.length;
      const step = Math.min(STEP_MS, SPREAD_MS / n, Math.max(0, MAX_LAG_MS - lag) / n);
      // Steps shrink evenly from a bit over `step` to ACCEL times faster, same total.
      const first = (2 * ACCEL) / (ACCEL + 1);
      const last = 2 / (ACCEL + 1);
      let t = Math.max(now, lastStart);
      for (let i = 0; i < n; i++) {
        t += step * (first + (last - first) * (n > 1 ? i / (n - 1) : 0));
        found[i].start = t;
      }
      lastStart = t;
      // Neighbours on a row that start within 4ms of each other fade as one rectangle,
      // so a whole block arriving at once is a few dozen rectangles, not thousands.
      let run = null;
      for (const f of found) {
        if (run && f.row === run.row && f.x === run.x + run.w && f.color === run.color && f.start - run.start < 4) {
          run.w += f.w;
          continue;
        }
        run = f;
        fades.push(f);
      }
      logBatch(found, lag, now);
    }
    draw();
  }

  function draw() {
    cancelAnimationFrame(frame);
    frame = 0;
    const now = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const w = screenEl.clientWidth;
    const h = screenEl.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cw = cellWidth();
    const ch = rowHeight();
    if (glide && now - glide.start >= GLIDE_MS) glide = null;
    const px = (y) => Math.round(y * ch * dpr) / dpr;
    ctx.save();
    if (glide) {
      // Cover the text above the box and draw each row where it is on its way.
      const bottom = glide.stop * ch;
      ctx.beginPath();
      ctx.rect(0, 0, w, bottom);
      ctx.clip();
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, w, bottom);
      const srcRow = shot.height / term.rows;
      for (let i = 0; i < glide.stop; i++) {
        ctx.drawImage(shot, 0, i * srcRow, shot.width, srcRow, 0, px(i + offsetAt(glide, i, now)), shot.width / dpr, ch);
      }
    }
    moveMarks(glide, now, ch);
    // A title redrawn on a moved row gets its new element after this render, in the same
    // frame; move that one too before the frame is shown.
    if (glide) { const g = glide; queueMicrotask(() => moveMarks(g, now, ch)); }
    fades = fades.filter((f) => now - f.start < FADE_MS);
    for (const f of fades) {
      if (f.row < 0 || f.row >= term.rows) continue;
      const p = Math.max(0, (now - f.start) / FADE_MS);
      ctx.globalAlpha = 1 - p * p * (3 - 2 * p);
      ctx.fillStyle = f.color;
      ctx.fillRect(Math.floor(f.x * cw), px(f.row + offsetAt(glide, f.row, now)), Math.ceil(f.w * cw) + 1, Math.ceil(ch) + 1);
    }
    ctx.restore();
    if (!fades.length && !glide) return;
    frame = requestAnimationFrame(draw);
    // Frames stop in a covered window; this still clears the last masks.
    clearTimeout(clearTimer);
    clearTimer = setTimeout(draw, FADE_MS + SPREAD_MS + GLIDE_MS);
  }

  // The 1.3x titles and pictures sit over their rows; they glide with them.
  let marksMoved = false;
  function moveMarks(g, now, ch) {
    if (!g && !marksMoved) return;
    if (g && g !== glide) return;
    marksMoved = !!g;
    for (const el of screenEl.querySelectorAll('.xterm-decoration')) {
      const row = Math.round(parseFloat(el.style.top) / ch);
      const off = g && row < g.stop ? offsetAt(g, row, now) : 0;
      el.style.transform = Math.abs(off) > 0.01 ? `translateY(${Math.round(off * ch)}px)` : '';
    }
  }

  function hush(reason) {
    r7.log('info', 'fade.hush', { session: cfg.session, reason, rows: term.rows, cols: term.cols });
    hushAt = performance.now();
    quietUntil = hushAt + QUIET_MS;
    prev = null;
    fades = [];
    glide = null;
    draw();
  }

  term.onRender(scan);
  term.onResize(() => hush('resize'));
  snapshotListeners.push(() => hush('attach'));
  term.parser.registerCsiHandler({ final: 'J' }, (params) => {
    if (params[0] >= 2) clearedAt = performance.now();
    return false;
  });
})();
