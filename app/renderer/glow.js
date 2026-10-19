'use strict';
// ---- attention glow ---------------------------------------------------------------
// When an agent's turn finishes (r7shell.attention / done in api.js) while the window
// isn't focused, the edges flash for 5s, then a tall bottom glow holds, and the flash comes
// back every 30s until the window is focused. The focused window keeps a shorter top
// glow. Drawn as soft glows fading inward, in the theme's brightest saturated color,
// which follows the colors the program sets.

const PULSE_MS = 5000;
const REMIND_MS = 30000;

const glowEl = document.createElement('div');
glowEl.id = 'glow';
glowEl.innerHTML = '<div class="edge"></div><div class="top"></div><div class="done"></div><div class="bottom"></div><div class="left"></div>';
document.body.appendChild(glowEl);

const attention = { phase: '', completedMs: 0, seen: false, since: 0 };
let glowTimer = 0;
let glowState = '';
let glowColorNow = '';
let clearedAttentionAt = 0;

function toHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

// A program can set the cursor to its accent color. The glow takes the most saturated light
// color near the accent's hue, which is the accent itself when it's vivid enough.
function pickGlowColor() {
  const valid = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const accent = valid(colors.cursor) ? toHsl(colors.cursor) : null;
  // Use the model's vivid accent directly.
  if (accent && accent.s >= 0.45 && accent.l >= 0.3 && accent.l <= 0.85) return colors.cursor;
  let best = '#ff4fb8';
  let bestScore = -1;
  for (const c of [colors.cursor, ...colors.palette.slice(1, 16)]) {
    if (!valid(c)) continue;
    const { h, s, l } = toHsl(c);
    if (l < 0.4 || l > 0.88 || s < 0.5) continue;
    const hueGap = accent && accent.s > 0.15 ? Math.min(Math.abs(h - accent.h), 360 - Math.abs(h - accent.h)) : 0;
    const score = s * (1 - 0.8 * hueGap / 180) + (c === colors.cursor ? 0.1 : 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// The glow is the picked theme colour with a slight saturation boost
// (HSB saturation, like Figma's slider), brightness kept.
function vivid(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(...rgb), min = Math.min(...rgb);
  if (max === 0 || max === min) return hex;
  const sat = (max - min) / max;
  const boosted = Math.min(1, sat + (1 - sat) * 0.2);
  const low = max * (1 - boosted);
  // Keep each channel's place between min and max, stretched to the new floor.
  return '#' + rgb.map((c) => Math.round(low + (c - min) / (max - min) * (max - low)).toString(16).padStart(2, '0')).join('');
}

function updateGlowColor() {
  const c = vivid(pickGlowColor());
  if (c === glowColorNow) return;
  glowColorNow = c;
  window.r7Accent = c;
  // Decorative colour belongs to these small surfaces, not every history node.
  for (const el of [termEl, glowEl, document.getElementById('r7-pins'), document.getElementById('r7-panel'), ...document.querySelectorAll('.r7-shimmer')]) {
    el?.style.setProperty('--r7-accent', c);
  }
  r7.log('info', 'glow.color', { session: cfg.session, color: c });
}

function setGlow(state, delayMs = 0) {
  if (state === glowState && !delayMs) return;
  glowState = state;
  glowEl.className = state;
  // Joins the flash cycle where the schedule says it is.
  glowEl.style.setProperty('--flash-delay', `${-delayMs}ms`);
}

function drawGlow() {
  clearTimeout(glowTimer);
  glowTimer = 0;
  const waiting = attention.phase === 'waiting';
  sendFlash(waiting && !attention.seen && !document.hasFocus());
  if (document.hidden) return setGlow('');
  if (document.hasFocus()) return setGlow(waiting ? 'seen' : 'focused');
  if (!waiting) return setGlow('');
  if (attention.seen) return setGlow('held');
  const elapsed = Math.max(0, Date.now() - (attention.completedMs || attention.since));
  const offset = elapsed % REMIND_MS;
  if (offset < PULSE_MS) {
    setGlow('pulse', offset);
    glowTimer = setTimeout(drawGlow, PULSE_MS - offset);
  } else {
    setGlow('waiting');
    glowTimer = setTimeout(drawGlow, REMIND_MS - offset);
  }
}

// The finish flash (main.js): an always-on-top glow along this window's bottom edge,
// now and every 30s, while a finished reply here is unseen.
let flashSent = '';
function sendFlash(on) {
  const at = attention.completedMs || attention.since;
  const key = on ? `on:${at}` : 'off';
  if (key === flashSent) return;
  flashSent = key;
  r7.finishFlash?.(on, at, glowColorNow);
}

// A finished turn counts as seen once the window has been focused.
attentionListeners.push((data) => {
  if (data.phase === 'active' || data.phase === 'working') clearedAttentionAt = 0;
  if (clearedAttentionAt && data.phase === 'waiting' && Number(data.completedMs || 0) <= clearedAttentionAt) return;
  if (data.phase === 'waiting' && attention.phase !== 'waiting') attention.since = Date.now();
  attention.phase = data.phase;
  attention.completedMs = data.completedMs;
  attention.seen = data.seen || (data.phase === 'waiting' && !document.hidden && document.hasFocus());
  drawGlow();
});

window.addEventListener('focus', () => {
  if (!document.hidden && attention.phase === 'waiting') attention.seen = true;
  drawGlow();
});
window.addEventListener('blur', drawGlow);
window.addEventListener('r7-clear', () => {
  clearedAttentionAt = Date.now();
  Object.assign(attention, { phase: '', completedMs: 0, seen: true, since: 0 });
  glowEl.classList.remove('flare');
  drawGlow();
});

// A reply that finished while the window is in use: marks.js lights its title, or asks
// for this flare of the bottom line when the title has scrolled off.
function flareBottom() {
  if (document.hidden) return;
  glowEl.classList.remove('flare');
  void glowEl.offsetWidth;
  glowEl.classList.add('flare');
}
glowEl.addEventListener('animationend', (event) => {
  if (event.target === glowEl.querySelector('.bottom')) glowEl.classList.remove('flare');
});

// The left divider only parts a window from one beside it: at its screen's left edge
// it would bleed a stripe of colour against the next monitor. Windows report no moves
// to the page, so the position is checked once a second.
const dividerEl = glowEl.querySelector('.left');
let dividerTimer = 0;
function placeDivider() {
  if (document.hidden) return;
  const atEdge = window.screenX - screen.availLeft <= 1;
  const display = atEdge ? 'none' : '';
  if (dividerEl.style.display !== display) dividerEl.style.display = display;
}
window.addEventListener('resize', placeDivider);

// Shade empty sides around the centered transcript column.
const sidesEl = document.createElement('div');
sidesEl.id = 'sides';
sidesEl.innerHTML = '<div class="l"></div><div class="r"></div>';
document.body.appendChild(sidesEl);
let sidesKey = '', sidesQueued = 0, sidesMiss = 0;
function placeSides() {
  sidesQueued = 0;
  if (document.hidden) return;
  const buf = term.buffer.active;
  if (buf.type !== 'normal' || buf.viewportY !== buf.baseY) return;
  const box = findBox();
  if (!box && ++sidesMiss < 3) return;
  if (box) sidesMiss = 0;
  let l = 0, r = 0;
  const column = window.r7View?.active ? document.getElementById('view-column')?.getBoundingClientRect() : null;
  if (column?.width) {
    // With the page drawn, the shade frames the page's column (wider than the box), never over it.
    l = Math.max(0, Math.round(column.left));
    r = Math.max(0, Math.round(window.innerWidth - column.right));
  } else if (box && box.left >= 4) {
    const cw = cellWidth(), rect = screenEl.getBoundingClientRect();
    l = Math.max(0, Math.round(rect.left + (box.left - 1) * cw));
    r = Math.max(0, Math.round(window.innerWidth - rect.left - (box.right + 2) * cw));
  }
  const key = `${l}|${r}`;
  if (key === sidesKey) return;
  sidesKey = key;
  const root = document.documentElement.style;
  root.setProperty('--side-l', `${l}px`);
  root.setProperty('--side-r', `${r}px`);
  document.body.classList.toggle('r7-wide', l > 0);
}
function queueSides() { if (!document.hidden && !sidesQueued) sidesQueued = requestAnimationFrame(placeSides); }
term.onRender(queueSides);
window.addEventListener('resize', () => { sidesKey = ''; queueSides(); });
window.addEventListener('r7-view-layout', queueSides);
queueSides();
colorListeners.push(updateGlowColor);
updateGlowColor();

const hiddenStyle = document.createElement('style');
hiddenStyle.textContent = 'html[data-r7-hidden] *, html[data-r7-hidden] *::before, html[data-r7-hidden] *::after { animation-play-state: paused !important; }';
document.head.appendChild(hiddenStyle);
function syncGlowVisibility() {
  document.documentElement.toggleAttribute('data-r7-hidden', document.hidden);
  clearInterval(dividerTimer);
  dividerTimer = 0;
  if (document.hidden) {
    cancelAnimationFrame(sidesQueued);
    sidesQueued = 0;
    glowEl.classList.remove('flare');
  } else {
    placeDivider();
    dividerTimer = setInterval(placeDivider, 1000);
    queueSides();
  }
  drawGlow();
}
document.addEventListener('visibilitychange', syncGlowVisibility);
syncGlowVisibility();
