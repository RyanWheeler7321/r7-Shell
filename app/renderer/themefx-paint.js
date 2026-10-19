'use strict';
// Paint worklet for theme transitions (themefx.js). `themefx` masks the new look in by character
// cells: opaque shows the new look (with --fx-invert, opaque marks cells not yet turned, for the
// working/resting overlay). `themefxglow` lights the cells turning over in the new accent.
// --fx-pattern picks the wave: 0 working/resting, then one per model so a switch reads as that
// model: 1 Opus ink bloom, 2 Sol starlit wave, 3 Sonnet diagonal flare, 4 Fable spiral,
// 5 Astra rising columns, 6 Luna crescent.

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => { v = clamp(v); return v * v * (3 - 2 * v); };
const bell = (a) => (a <= 0 || a >= 1 ? 0 : Math.pow(4 * a * (1 - a), 2));

function hash(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Each cell's turn in the wave, 0 (first) to about 1 (last).
function turn(pattern, i, j, cx, cy, W, H, ox, oy, maxD) {
  const dx = cx - ox, dy = cy - oy;
  const d = Math.hypot(dx, dy * 1.3) / (maxD * 1.3);
  const nx = cx / W, ny = cy / H;
  const along = oy < H / 2 ? ny : 1 - ny;
  switch (pattern) {
    case 1: return d * 0.78 + noise(cx / 110, cy / 110) * 0.22;
    case 2: return d * 0.9 + hash(i, j) * 0.1;
    case 3: return (nx * 0.6 + along * 0.4) * 0.92 + hash(i, j) * 0.08;
    case 4: {
      const a = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
      return d * 0.6 + ((a * 2 + d * 2.2) % 1) * 0.32 + hash(i, j) * 0.08;
    }
    case 5: return along * 0.72 + hash(i, 7) * 0.22 + nx * 0.06;
    case 6: return clamp(nx * 0.78 + (along - 0.38) * (along - 0.38) * 0.9) * 0.94 + hash(i, j) * 0.06;
    default: return d * 0.92 + hash(i, j) * 0.08;
  }
}

// Geometry is constant for a wave; only its progress changes each frame.
const grids = new Map();
function gridFor(pattern, W, H, ox, oy, cw, ch) {
  const key = [pattern, W, H, ox, oy, cw, ch].join(',');
  if (grids.has(key)) return grids.get(key);
  const cols = Math.ceil(W / cw), rows = Math.ceil(H / ch);
  const turns = new Float64Array(cols * rows), stars = new Uint8Array(cols * rows);
  const maxD = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy));
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const at = j * cols + i;
    turns[at] = turn(pattern, i, j, (i + 0.5) * cw, (j + 0.5) * ch, W, H, ox, oy, maxD);
    stars[at] = pattern === 2 && hash(j, i) > 0.92 ? 1 : 0;
  }
  if (grids.size >= 4) grids.delete(grids.keys().next().value);
  const grid = { cols, rows, turns, stars };
  grids.set(key, grid);
  return grid;
}

function draw(ctx, size, props, glow) {
  const num = (k) => parseFloat(String(props.get(k)).trim()) || 0;
  const p = num('--fx-p'), pattern = Math.round(num('--fx-pattern')), invert = !glow && num('--fx-invert') > 0;
  const W = size.width, H = size.height, ox = num('--fx-ox'), oy = num('--fx-oy');
  const cw = Math.max(4, num('--fx-cw') || 9.6), ch = Math.max(8, num('--fx-ch') || 25);
  if (invert) {
    if (p >= 1) return;
    if (p <= 0) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
  } else {
    if (!glow && p >= 1) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    if (p <= 0 || (glow && p >= 1)) return;
  }
  ctx.fillStyle = glow ? (String(props.get('--fx-color')).trim() || '#fff') : '#000';
  const grid = gridFor(pattern, W, H, ox, oy, cw, ch);
  const band = pattern === 3 ? 0.1 : 0.15;
  const reach = p * (1 + band + 0.04);
  for (let j = 0, y = 0; j < grid.rows; j++, y += ch) {
    let run = -1;
    for (let i = 0, x = 0; i < grid.cols; i++, x += cw) {
      const at = j * grid.cols + i;
      const a = smooth((reach - grid.turns[at]) / band);
      if (!glow) {
        const v = invert ? 1 - a : a;
        if (v === 1) { if (run < 0) run = x; continue; }
        if (run >= 0) { ctx.globalAlpha = 1; ctx.fillRect(run, y, x - run + 0.5, ch + 0.5); run = -1; }
        if (v <= 0.004) continue;
        ctx.globalAlpha = v; ctx.fillRect(x, y, cw + 0.5, ch + 0.5);
        continue;
      }
      // Sol's wave carries a few brighter cells, like stars.
      const lit = grid.stars[at] ? 0.85 : 0.32;
      const v = bell(a) * lit;
      if (v <= 0.004) continue;
      ctx.globalAlpha = v; ctx.fillRect(x + 1, y + 4, cw - 2, ch - 8);
    }
    if (run >= 0) { ctx.globalAlpha = 1; ctx.fillRect(run, y, grid.cols * cw - run + 0.5, ch + 0.5); }
  }
}

class ThemeFx {
  static get inputProperties() { return ['--fx-p', '--fx-pattern', '--fx-invert', '--fx-ox', '--fx-oy', '--fx-cw', '--fx-ch', '--fx-color']; }
  paint(ctx, size, props) { draw(ctx, size, props, false); }
}
class ThemeFxGlow extends ThemeFx {
  paint(ctx, size, props) { draw(ctx, size, props, true); }
}
registerPaint('themefx', ThemeFx);
registerPaint('themefxglow', ThemeFxGlow);
