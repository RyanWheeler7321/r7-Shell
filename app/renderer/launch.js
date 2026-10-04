'use strict';
// Launch screen for a fresh session of a template with `launch.ready` (started by input.js
// with type-ahead). ASCII water in the theme's colors rises from the bottom as a loading bar
// while the program starts, paced by how long the last starts took. When it's ready, the water surges and
// dissolves in a ripple spreading from the input box, revealing the ready screen.

const launch = (() => {
  const FINISH_MS = 700;
  let key = '';
  let canvas = null;
  let ctx = null;
  let frame = 0;
  let startedAt = 0;
  let endedAt = 0;
  let level = 0;
  let near = -1;
  let origin = { x: 0, y: 0 };
  let expected = 3000;

  // The theme's blue slot is its accent: a lighter tint of it on the surface, the accent
  // itself below, and a darker shade going deeper.
  function mix(a, b, t) {
    const ch = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
    return '#' + [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('');
  }
  function tones() {
    const hex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
    const accent = hex(colors.palette?.[4]) ? colors.palette[4] : hex(colors.cursor) ? colors.cursor : '#9367fb';
    const bg = hex(colors.bg) ? colors.bg : '#000000';
    return { surface: mix(accent, '#ffffff', 0.35), shallow: accent, deep: mix(accent, bg, 0.45) };
  }

  // `kind` keeps a separate pace, so a refresh (the program restarting in place) has its own.
  function start(kind = '') {
    remove();
    key = `r7.bootMs.${cfg.template}${kind ? `.${kind}` : ''}`;
    expected = Number(localStorage.getItem(key)) || 3000;
    endedAt = 0;
    near = -1;
    level = 0;
    canvas = document.createElement('canvas');
    canvas.id = 'launch';
    screenEl.appendChild(canvas);
    ctx = canvas.getContext('2d');
    startedAt = performance.now();
    frame = requestAnimationFrame(draw);
  }

  // `box` is the input box's top row, so the ripple starts there.
  // `ready` false: the program never came up and type-ahead gave up, which says nothing
  // about how long a start takes, so the pace isn't kept.
  function end(box, ready = true) {
    if (!canvas || endedAt) return;
    endedAt = performance.now();
    const boot = endedAt - startedAt;
    // Next time's pace: mostly the last boot, a little of the ones before.
    if (ready) localStorage.setItem(key, String(Math.round(expected * 0.3 + boot * 0.7)));
    origin = { x: 4, y: box ? box + 1 : 3 };
    r7.log('info', 'launch.done', { session: cfg.session, bootMs: Math.round(boot), key });
  }

  function remove() {
    cancelAnimationFrame(frame);
    canvas?.remove();
    canvas = null;
  }

  // A cheap smooth noise from a few sines, for the water's shimmer.
  const wave = (x, t) => Math.sin(x * 0.21 + t * 1.7) * 0.9 + Math.sin(x * 0.083 - t * 1.1) * 1.3 + Math.sin(x * 0.53 + t * 2.9) * 0.35;

  // Swells under the surface: bands of ripples, each row drifting its own way and speed.
  function swell(x, y, t) {
    const dir = y % 2 ? 1 : -1;
    const v = Math.sin(x * 0.32 + dir * t * (1.4 + (y % 3) * 0.5) + y * 1.9) + Math.sin(x * 0.11 - t * 0.6 + y * 0.7) * 0.6;
    if (v > 0.95) return '~';
    if (v > 0.35) return '-';
    if (v > -0.35) return '·';
    return ' ';
  }

  function draw() {
    const now = performance.now();
    const t = (now - startedAt) / 1000;
    const dpr = window.devicePixelRatio || 1;
    const w = screenEl.clientWidth;
    const h = screenEl.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const cw = cellWidth();
    const ch = rowHeight();
    const cols = term.cols;
    const rows = term.rows;
    // A loading bar that never stops: the water rises steadily to 92% by the expected boot
    // time, then keeps rising ever slower toward the top. Finishing: it reaches the top at
    // that pace, or within 300ms when the boot beat the estimate, while a ripple clears it.
    const rate = 0.92 / expected;
    const rise = (ms) => {
      const lin = rate * ms;
      return lin <= 0.92 ? lin : 0.92 + 0.07 * (1 - Math.exp(-(lin - 0.92) / 0.07));
    };
    const loading = rise((endedAt || now) - startedAt);
    const done = endedAt ? Math.min(1, (now - endedAt) / FINISH_MS) : 0;
    level = endedAt ? Math.min(1, loading + Math.max(rate, (1 - loading) / 300) * (now - endedAt)) : loading;
    // The ripple clears the same amount of water every frame: it starts at the water's
    // surface, its area grows linearly, and it reaches the far corner as it ends.
    const reach = Math.hypot(Math.max(origin.x, cols - origin.x), Math.max(origin.y, rows - origin.y) * 2.2) + 4;
    if (endedAt && near < 0) near = Math.min(reach, Math.max(0, rows * (1 - level) - 2 - origin.y) * 2.2);
    const radius = endedAt ? Math.sqrt(near * near + done * (reach * reach - near * near)) : -1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // The screen stays covered, except inside the ripple once the program is ready.
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    const ox = (origin.x + 0.5) * cw;
    const oy = (origin.y + 0.5) * ch;
    if (radius > 0) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.ellipse(ox, oy, radius * cw, (radius / 2.2) * ch, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
    // Each row is one string, spaced out to the grid's cells.
    ctx.letterSpacing = `${cw - ctx.measureText('~').width}px`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const tone = tones();
    const amp = 1.1;
    const base = rows * (1 - level);
    const surf = new Float32Array(cols);
    let top = rows;
    for (let x = 0; x < cols; x++) {
      surf[x] = base + wave(x, t) * amp;
      top = Math.min(top, Math.ceil(surf[x]));
    }
    const ring = [];
    for (let y = Math.max(0, top); y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        let glyph = y < Math.ceil(surf[x]) ? ' ' : swell(x, y, t);
        if (radius > 0 && glyph !== ' ') {
          const dist = Math.hypot(x - origin.x, (y - origin.y) * 2.2);
          if (dist < radius) {
            if (dist >= radius - 3) ring.push({ x, y, a: 1 - (radius - dist) / 3 });
            glyph = ' ';
          }
        }
        line += glyph;
      }
      const depth = (y - base) / rows;
      ctx.globalAlpha = Math.max(0.15, 0.9 - depth * 1.4);
      ctx.fillStyle = depth < 0.12 ? tone.shallow : tone.deep;
      ctx.fillText(line, 0, (y + 0.5) * ch);
    }
    ctx.letterSpacing = '0px';
    ctx.textAlign = 'center';
    // The surface sits between rows, so it moves smoothly; the ripple's edge glints.
    ctx.fillStyle = tone.surface;
    ctx.globalAlpha = 1;
    for (let x = 0; x < cols; x++) {
      const sy = surf[x] - 0.5;
      if (sy <= -1 || Math.hypot(x - origin.x, (sy - origin.y) * 2.2) < radius) continue;
      ctx.fillText('~', (x + 0.5) * cw, (sy + 0.5) * ch);
    }
    for (const c of ring) {
      ctx.globalAlpha = c.a;
      ctx.fillText('·', (c.x + 0.5) * cw, (c.y + 0.5) * ch);
    }
    ctx.globalAlpha = 1;
    if (endedAt && done >= 1) { remove(); return; }
    frame = requestAnimationFrame(draw);
  }

  return { start, end };
})();
