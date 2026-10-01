'use strict';
// ---- attention glow ---------------------------------------------------------------
// When an agent's turn finishes (r7shell.attention / done in api.js) while the window
// isn't focused, the edges flash for 5s, then a tall top glow holds, and the flash comes
// back every 30s until the window is focused. The focused window keeps a shorter top
// glow. Drawn as soft glows fading inward, in the theme's brightest saturated color,
// which follows the colors the program sets.

const PULSE_MS = 5000;
const REMIND_MS = 30000;

const glowEl = document.createElement('div');
glowEl.id = 'glow';
glowEl.innerHTML = '<div class="edge"></div><div class="top"></div><div class="bottom"></div><div class="left"></div>';
document.body.appendChild(glowEl);

const attention = { phase: '', completedMs: 0, seen: false, since: 0 };
let glowTimer = 0;
let glowState = '';
let glowColorNow = '';

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
  document.documentElement.style.setProperty('--r7-accent', c);
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
  const waiting = attention.phase === 'waiting';
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

// A finished turn counts as seen once the window has been focused.
attentionListeners.push((data) => {
  if (data.phase === 'waiting' && attention.phase !== 'waiting') attention.since = Date.now();
  attention.phase = data.phase;
  attention.completedMs = data.completedMs;
  attention.seen = data.seen || (data.phase === 'waiting' && document.hasFocus());
  drawGlow();
});

window.addEventListener('focus', () => {
  if (attention.phase === 'waiting') attention.seen = true;
  drawGlow();
});
window.addEventListener('blur', drawGlow);

// The left divider only parts a window from one beside it: at its screen's left edge
// it would bleed a stripe of colour against the next monitor. Windows report no moves
// to the page, so the position is checked once a second.
const dividerEl = glowEl.querySelector('.left');
function placeDivider() {
  const atEdge = window.screenX - screen.availLeft <= 1;
  dividerEl.style.display = atEdge ? 'none' : '';
}
setInterval(placeDivider, 1000);
window.addEventListener('resize', placeDivider);
placeDivider();
colorListeners.push(updateGlowColor);
updateGlowColor();
drawGlow();
