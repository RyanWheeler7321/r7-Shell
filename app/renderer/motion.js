'use strict';
// Short animations on r7-Harness's input box, drawn on one canvas over the screen, which
// only draws while one of them runs: the sent message lifting into the chat, the thinking
// level's gauge on the box's top border, a question's number hopping into the box
// (marks.js calls motion.hop) and the chat folding away when r7-Harness compacts it
// (`OSC 7321;compact;start` and `;done`).

const motion = (() => {
  const canvas = document.createElement('canvas');
  canvas.id = 'r7-motion';
  screenEl.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let effects = []; // { start, ms, draw(p, now) }
  let frame = 0;

  const easeOut = (p) => 1 - (1 - p) ** 3;
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const validHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  function rgba(c, a) {
    const [r, g, b] = validHex(c) ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : [255, 255, 255];
    return `rgba(${r},${g},${b},${clamp(a)})`;
  }
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--r7-accent').trim() || colors.cursor || colors.fg;
  const rowText = (r) => term.buffer.active.getLine(term.buffer.active.viewportY + r)?.translateToString(true) ?? '';

  function cellColor(cell) {
    if (cell.isFgRGB()) return '#' + cell.getFgColor().toString(16).padStart(6, '0');
    if (cell.isFgPalette()) return colors.palette[cell.getFgColor()] || colors.fg;
    return colors.fg;
  }

  function add(effect) {
    if (document.hidden) return;
    effects.push({ start: performance.now(), ...effect });
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw() {
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
    for (const e of effects) {
      const p = (now - e.start) / e.ms;
      if (p >= 1) { e.end?.(); continue; }
      ctx.save();
      e.draw(clamp(p), now);
      ctx.restore();
    }
    effects = effects.filter((e) => now - e.start < e.ms);
    if (effects.length) frame = requestAnimationFrame(draw);
  }

  function textFont(scale = 1) {
    ctx.font = `${term.options.fontSize * scale}px ${term.options.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.letterSpacing = `${cellWidth() * scale - ctx.measureText('M').width}px`;
  }

  // ---- send: the message flashes and snaps out of the box ---------------------------
  // The box and its text flash white for a beat (the box's outline kicking outward, its
  // inside lit), then the text shoots up accelerating with a short streak. Three takes so
  // it isn't the same every time: straight up, a small flick with a tilt, or the letters
  // firing one after another.

  const SEND_MS = 270;
  const FLASH = 0.24; // share of SEND_MS the text holds still and flashes
  const easeIn = (p) => p * p;
  let lastTake = -1;

  function boxLines(box) {
    const lines = [];
    for (let r = box.top + 1; r <= box.bottom; r++) {
      const text = [...rowText(r)].slice(box.left + 3, box.right - 2).join('').replace(/[─│╯\s]+$/, '');
      lines.push({ row: r, text });
    }
    while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop();
    return lines.some((l) => l.text.trim()) ? lines : null;
  }

  function lift() {
    if (!harness.on) return;
    const box = findBox();
    if (!box || term.buffer.active.cursorY <= box.top || term.buffer.active.cursorY > box.bottom) return;
    const lines = boxLines(box);
    if (!lines) return;
    let take = Math.floor(Math.random() * 3);
    if (take === lastTake) take = (take + 1) % 3;
    lastTake = take;
    const chars = lines.reduce((n, l) => n + l.text.length, 0);
    if (take === 2 && chars > 240) take = 0;
    // The flick lifts the far end a little.
    const tilt = -(0.5 + Math.random() * 0.4);
    const rise = 2.4 + Math.random() * 0.6;
    const tint = colors.fg;
    const glow = accent();
    add({
      ms: SEND_MS,
      draw(p) {
        const cw = cellWidth();
        const ch = rowHeight();
        // The box flash: its inside lit white and its outline kicking outward, white-hot
        // with the accent glow around it, gone in the first half.
        const b = clamp(p / 0.55);
        if (b < 1) {
          const k = (1 - b) ** 1.6;
          const grow = easeOut(b) * 5;
          const x0 = (box.left + 0.5) * cw - grow;
          const y0 = (box.top + 0.5) * ch - grow;
          const x1 = (box.right + 0.5) * cw + grow;
          const y1 = (box.bottom + 0.5) * ch + grow;
          ctx.save();
          ctx.globalAlpha = 0.16 * k;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          ctx.globalAlpha = k;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.shadowColor = glow;
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 6);
          ctx.stroke();
          ctx.stroke();
          ctx.restore();
        }
        textFont();
        ctx.shadowColor = glow;
        if (take === 2) {
          // Each letter fires a moment after the one before.
          let i = 0;
          const step = Math.min(1.5, 50 / Math.max(1, chars));
          const each = SEND_MS - 50;
          ctx.letterSpacing = '0px';
          ctx.textAlign = 'center';
          for (const l of lines) {
            [...l.text].forEach((c, x) => {
              const q = clamp((p * SEND_MS - i++ * step) / each);
              if (c === ' ' || q >= 1) return;
              const flash = q < FLASH;
              const e = flash ? 0 : easeIn((q - FLASH) / (1 - FLASH));
              ctx.fillStyle = flash ? '#ffffff' : tint;
              ctx.shadowBlur = flash ? 20 : 8 * (1 - e);
              if (flash) ctx.fillText(c, (x + box.left + 3.5) * cw, (l.row + 0.5) * ch);
              ctx.globalAlpha = 1 - e ** 2.5;
              ctx.fillText(c, (x + box.left + 3.5) * cw, (l.row + 0.5 - e * rise) * ch);
            });
          }
          return;
        }
        const top = lines[0].row * ch;
        const left = (box.left + 3) * cw;
        const block = (e, alpha) => {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(left, top);
          if (take === 1) {
            ctx.translate(e * cw * 0.8, 0);
            ctx.rotate((tilt * e * Math.PI) / 180);
          }
          ctx.translate(0, -e * rise * ch);
          // Stretched along the move as it speeds up, like a smear frame.
          ctx.scale(1 - 0.04 * e, 1 + 0.18 * e);
          for (const l of lines) ctx.fillText(l.text, 0, (l.row - lines[0].row + 0.5) * ch);
          ctx.restore();
        };
        if (p < FLASH) {
          // The flash: white-hot with a wide glow (drawn twice so it blooms), nudged down
          // a hair like a key going in.
          const f = p / FLASH;
          ctx.fillStyle = '#ffffff';
          ctx.translate(0, Math.sin(f * Math.PI) * ch * 0.08);
          ctx.shadowBlur = 22;
          block(0, 1);
          ctx.shadowBlur = 8;
          block(0, 1);
          return;
        }
        const e = easeIn((p - FLASH) / (1 - FLASH));
        ctx.fillStyle = tint;
        ctx.shadowBlur = 12 * (1 - e);
        // A short streak: fainter copies trailing just below.
        block(Math.max(0, e - 0.16), 0.18 * (1 - e));
        block(Math.max(0, e - 0.08), 0.35 * (1 - e));
        block(e, 1 - e ** 2.5);
      },
    });
  }

  // Enter sends what's in the box (Alt+Enter is a new line). Hooks before this one
  // (type-ahead, the box selection) have had their turn.
  editHooks.push((data) => {
    if (data === '\r') lift();
    return false;
  });

  // ---- thinking level: a gauge fills or drains along the box's top border ------------

  // Shift+Tab only cycles these five; anything else (off, auto, min) reads as empty.
  const LEVELS = ['low', 'med', 'high', 'xhigh', 'max'];
  const LEVEL_RE = /[⦸○◔◑◒◕◉⟳] (off|min|low|med|high|xhigh|max|auto)\b/;
  let levelWatch = null; // { level, until }

  // The gauge sits centred on the top border, so a longer model or level name never
  // moves it. It shrinks to fit the run of ─ around the centre on narrow windows.
  function gaugeSpot(row, text, box) {
    const cells = [...text];
    const mid = Math.round((box.left + box.right) / 2);
    let a = mid, b = mid;
    while (a > 0 && cells[a - 1] === '─') a--;
    while (b < cells.length - 1 && cells[b + 1] === '─') b++;
    const room = cells[mid] === '─' ? Math.min(mid - a, b - mid) - 2 : 0;
    const half = Math.min(12, room);
    if (half < 4) return null;
    return { x0: mid - half, span: half * 2 };
  }

  function readLevel() {
    const box = findBox();
    if (!box) return null;
    const text = rowText(box.top);
    const m = LEVEL_RE.exec(text);
    if (!m) return null;
    const col = [...text.slice(0, m.index)].length;
    return { level: LEVELS.indexOf(m[1]), word: m[1], row: box.top, col, len: [...m[0]].length, spot: gaugeSpot(box.top, text, box) };
  }

  function gauge(from, to) {
    const line = term.buffer.active.getLine(term.buffer.active.viewportY + to.row);
    const color = line?.getCell(to.col) ? cellColor(line.getCell(to.col)) : accent();
    const spot = to.spot;
    // Tick i sits at (i + 1) / 5 of the span, so even low shows some fill.
    const at = (lv) => (spot ? ((lv + 1) / LEVELS.length) * spot.span : 0);
    add({
      ms: 900,
      draw(p, now) {
        const cw = cellWidth();
        const ch = rowHeight();
        const y = (to.row + 0.5) * ch;
        if (spot) {
          const q = easeOut(clamp(p / 0.25));
          const len = at(from.level) + (at(to.level) - at(from.level)) * q;
          const fade = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
          const x0 = spot.x0 * cw;
          ctx.globalAlpha = fade;
          // Dark backing so the gauge reads over the border line, then a dim track.
          ctx.fillStyle = colors.bg;
          ctx.fillRect(x0 - cw * 0.5, y - ch * 0.3, (spot.span + 1) * cw, ch * 0.6);
          ctx.fillStyle = rgba(color, 0.35);
          ctx.fillRect(x0, y - 1, spot.span * cw, 2);
          // One tick per level: lit ones white, the rest faint.
          for (let i = 0; i < LEVELS.length; i++) {
            const x = x0 + at(i) * cw;
            const lit = at(i) <= len + 0.01;
            ctx.shadowColor = lit ? '#ffffff' : 'transparent';
            ctx.shadowBlur = lit ? 10 : 0;
            ctx.fillStyle = lit ? '#ffffff' : rgba(color, 0.3);
            ctx.fillRect(x - 1.5, y - ch * 0.26, 3, ch * 0.52);
          }
          ctx.shadowColor = '#ffffff';
          ctx.shadowBlur = 12;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x0, y - 2, len * cw, 4);
          ctx.shadowBlur = 0;
        }
        // The level's name pops: a bright copy that settles back onto the real one.
        const pop = 1 - easeOut(clamp(p / 0.4));
        if (pop > 0.01) {
          textFont();
          ctx.globalAlpha = pop * 0.9;
          ctx.shadowBlur = 10 * pop;
          ctx.fillStyle = color;
          const cx = (to.col + to.len / 2) * cw;
          ctx.translate(cx, y);
          ctx.scale(1 + 0.18 * pop, 1 + 0.18 * pop);
          ctx.textAlign = 'center';
          ctx.letterSpacing = '0px';
          const label = rowText(to.row).slice(to.col, to.col + to.len);
          // Drawn per cell so it keeps the grid's spacing.
          [...label].forEach((c, i) => ctx.fillText(c, (i - to.len / 2 + 0.5) * cw, 0));
        }
      },
    });
  }

  // Shift+Tab cycles the level; r7-Harness redraws the border a moment later.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.altKey || !harness.on) return;
    const now = readLevel();
    if (now) levelWatch = { from: now, until: performance.now() + 800 };
  }, true);

  term.onRender(() => {
    if (!levelWatch) return;
    if (performance.now() > levelWatch.until) { levelWatch = null; return; }
    const now = readLevel();
    if (!now || now.word === levelWatch.from.word) return;
    gauge(levelWatch.from, now);
    levelWatch = null;
  });

  // ---- question number hopping into the box ------------------------------------------
  // From the question line to the cursor in the box, on a small arc; `land` runs when it
  // gets there.

  function hop(text, from, to, color, land) {
    const HOP_MS = 190;
    const glow = accent();
    add({
      ms: HOP_MS + 160,
      draw(p) {
        const cw = cellWidth();
        const ch = rowHeight();
        const t = (p * (HOP_MS + 160)) / HOP_MS;
        const tx = (to.x + 0.5) * cw;
        const ty = (to.y + 0.5) * ch;
        if (t < 1) {
          const e = easeInOut(t);
          const x = (from.x + 0.5) * cw + (tx - (from.x + 0.5) * cw) * e;
          const y = (from.y + 0.5) * ch + (ty - (from.y + 0.5) * ch) * e - Math.sin(Math.PI * e) * ch * 1.6;
          textFont(1.15 - 0.15 * e);
          ctx.shadowColor = glow;
          ctx.shadowBlur = 10;
          ctx.fillStyle = color;
          ctx.fillText(text, x - 0.5 * cw, y);
          return;
        }
        // Landed: it stays a moment while the typed copy appears under it, and a flat
        // ring spreads around it.
        const q = (t - 1) / (160 / HOP_MS);
        ctx.shadowColor = glow;
        ctx.shadowBlur = 8;
        if (q < 0.4) {
          textFont();
          ctx.globalAlpha = 1 - q / 0.4;
          ctx.fillStyle = color;
          ctx.fillText(text, tx - 0.5 * cw, ty);
        }
        const cx = tx + ([...text].length - 1) * cw / 2;
        ctx.globalAlpha = (1 - q) * 0.9;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, ty, cw * (1.1 + 1.3 * easeOut(q)), ch * (0.45 + 0.2 * easeOut(q)), 0, 0, Math.PI * 2);
        ctx.stroke();
      },
    });
    setTimeout(land, HOP_MS);
  }

  // ---- compaction: the old chat folds into a seam, the new one opens from it ----------
  // The chat is copied when compaction starts (the GPU canvas can only be read right after
  // it draws, so the screen is redrawn once for it) and folded when it ends, before
  // r7-Harness's reprint has drawn, while the reprint opens up behind it.

  let foldShot = null; // { canvas, rows, cols, chatRows }
  let wantFoldShot = false;

  function copyScreen() {
    const layers = [...screenEl.querySelectorAll('canvas')].filter((c) => c !== canvas && !c.id && c.width && c.height);
    if (!layers.length) return null;
    const out = document.createElement('canvas');
    out.width = layers[0].width;
    out.height = layers[0].height;
    const c = out.getContext('2d');
    for (const layer of layers) c.drawImage(layer, 0, 0, out.width, out.height);
    return out;
  }

  term.onRender(() => {
    if (!wantFoldShot) return;
    wantFoldShot = false;
    const box = findBox();
    const shot = box && box.top > 2 ? copyScreen() : null;
    foldShot = shot ? { canvas: shot, rows: term.rows, cols: term.cols, chatRows: box.top } : null;
  });
  term.onResize(() => { foldShot = null; wantFoldShot = false; });

  function fold() {
    const shot = foldShot;
    foldShot = null;
    if (!shot || shot.rows !== term.rows || shot.cols !== term.cols) return;
    const line = accent();
    add({
      ms: 460,
      draw(p) {
        const w = screenEl.clientWidth;
        const ch = rowHeight();
        const area = shot.chatRows * ch;
        const seam = area * 0.5;
        const src = (shot.canvas.height / shot.rows) * shot.chatRows;
        if (p < 0.45) {
          // Folding: the old chat squeezes toward the seam over a covered screen.
          const e = easeInOut(p / 0.45);
          ctx.fillStyle = colors.bg;
          ctx.fillRect(0, 0, w, area);
          const hh = area * (1 - e);
          ctx.globalAlpha = 1 - 0.5 * e;
          ctx.drawImage(shot.canvas, 0, 0, shot.canvas.width, src, 0, seam - hh / 2, w, hh);
          ctx.globalAlpha = e;
        } else {
          // Opening: the new chat shows through a gap growing from the seam.
          const e = easeOut((p - 0.45) / 0.55);
          const open = area * e;
          ctx.fillStyle = colors.bg;
          ctx.fillRect(0, 0, w, Math.max(0, seam - open / 2));
          ctx.fillRect(0, seam + open / 2, w, Math.max(0, area - seam - open / 2));
          ctx.globalAlpha = 1 - e;
        }
        ctx.shadowColor = line;
        ctx.shadowBlur = 12;
        ctx.fillStyle = line;
        ctx.fillRect(0, seam - 1, w, 2);
      },
    });
  }

  term.parser.registerOscHandler(7321, (data) => {
    if (data === 'compact;start') {
      if (document.hidden) return true;
      wantFoldShot = true;
      term.refresh(0, term.rows - 1);
      return true;
    }
    if (data === 'compact;done') { fold(); return true; }
    return false;
  });

  return { hop };
})();
