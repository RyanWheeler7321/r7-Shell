'use strict';
// ---- Ctrl+P model switch ------------------------------------------------------------
// r7-Harness sends `OSC 7321;cycle;<json>` instead of printing its model chips above the
// input box, and `OSC 7321;cycle` alone when they should go. The chips float here over
// the chat, so the box never moves: the highlight slides to the new model, the input box
// is wiped over to its new look from left to right, and Luna, Sol, Opus and Astra models
// each have their own short flourish. The theme's accent tints the highlight a little and
// colours the wipe and flourish; a program can send per-model colours instead
// (`OSC 7321;looks;<json>`).
// r7-Harness answers Ctrl+P about 120-140ms later (it switches the model and its theme
// first), so the highlight moves on the key press itself, guessing the next chip from
// the last track, and the answer only corrects it when the guess was wrong.
// The track also comes at startup without showing it (`OSC 7321;cycle-state;<json>`)
// and each session's last track is kept across reloads, so even the first press moves at once.
// Any other key means the pick is done: the chips go at once, and answers to earlier presses
// only update the track.

(() => {
  const WIPE_MS = 220;
  const HIDE_AFTER_MS = 6000; // r7-Harness hides them at 4s; this only covers a lost message
  const GUESS_WAIT_MS = 700; // no answer by then: the key didn't switch models, so put it back
  const ANSWER_MS = 1000; // answers to a press come well within this
  const TRACKS_KEY = 'r7.cycleTracks';

  const root = document.createElement('div');
  root.id = 'r7-cycle';
  root.innerHTML = '<div class="shade"></div><div class="chips"><div class="pill"></div></div><div class="folder"></div>';
  screenEl.appendChild(root);
  const chipsEl = root.querySelector('.chips');
  const pillEl = root.querySelector('.pill');
  const folderEl = root.querySelector('.folder');
  const shadeEl = root.querySelector('.shade');

  const fx = document.createElement('canvas');
  fx.id = 'r7-cycle-fx';
  screenEl.appendChild(fx);
  const fxCtx = fx.getContext('2d');

  let track = null; // { labels, active, colors, folder, models, slots: [{ x, w, el }] }
  let hideTimer = 0;
  let guesses = 0; // Ctrl+P presses moved ahead of r7-Harness's answers
  let confirmed = -1; // the active chip in r7-Harness's last answer
  let guessTimer = 0;
  let pressedAt = -Infinity; // last Ctrl+P or Ctrl+Shift+P
  let dismissedAt = -Infinity; // last key that sent the chips away
  let looks = null;
  try { looks = JSON.parse(localStorage.getItem('r7.cycleLooks') || 'null'); } catch {}

  // The box as it looked just before Ctrl+P, and a wipe from it to the new look.
  let wantShot = null; // { top, bottom }
  let oldBox = null; // { top, bottom, texts, canvas, at }
  let wipe = null; // { start, top, bottom, canvas, color }
  let effects = []; // { start, ms, draw(ctx, p) }
  let frame = 0;

  // A model's family without its version (`claude-opus-5` gives `claude-opus`), so point
  // releases share one look and one flourish.
  function modelKey(id) {
    const base = String(id || '').toLowerCase().replace(/:.*$/, '').replace(/^.*\//, '');
    const family = base.split(/[-_\s]+/).filter((t) => t && !/^(?:\d+(?:\.\d+)*|latest)$/.test(t)).join('-');
    return (family || base).replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  }

  const validHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const rgbOf = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  function mix(a, b, t) {
    if (!validHex(a)) return b;
    if (!validHex(b)) return a;
    const x = rgbOf(a), y = rgbOf(b);
    return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  function rgba(c, alpha) {
    const [r, g, b] = validHex(c) ? rgbOf(c) : [255, 255, 255];
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
  }
  function inkOn(c) {
    const [r, g, b] = rgbOf(c).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#0b0710' : '#ffffff';
  }

  // The model's working colour, or the shared working colour, or the theme's accent.
  function accentFor(index) {
    const key = modelKey(track?.models?.[index]);
    const c = looks?.models?.[key] || looks?.default;
    return validHex(c) ? c : vivid(pickGlowColor());
  }

  const easeOut = (p) => 1 - (1 - p) ** 3;
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const bell = (p) => Math.sin(Math.PI * Math.max(0, Math.min(1, p)));

  function rowText(buf, r) {
    const line = buf.getLine(buf.viewportY + r);
    return line ? line.translateToString(true) : '';
  }

  function boxTexts(box) {
    const buf = term.buffer.active;
    const out = [];
    for (let r = box.top; r <= box.bottom; r++) out.push(rowText(buf, r));
    return out;
  }

  // Copy rows of the terminal's own canvases while a render is still on them.
  function copyRows(top, bottom) {
    const layers = [...screenEl.querySelectorAll('canvas')].filter((c) => c !== fx && c.id !== 'fade-mask' && c.id !== 'r7-motion' && c.width && c.height);
    if (!layers.length) return null;
    const base = layers[0];
    const src = base.height / term.rows;
    const out = document.createElement('canvas');
    out.width = base.width;
    out.height = Math.round((bottom - top + 1) * src);
    const c = out.getContext('2d');
    for (const layer of layers) {
      const s = layer.height / term.rows;
      c.drawImage(layer, 0, top * s, layer.width, (bottom - top + 1) * s, 0, 0, out.width, out.height);
    }
    return out;
  }

  // ---- the chips ------------------------------------------------------------------

  function layout() {
    if (!track) return;
    const box = findBox();
    // Over the chat above the box, or under the box while the chat is still too short.
    let chipRow = box ? box.top - 4 : -1;
    if (box && chipRow < 0 && box.bottom + 3 < term.rows) chipRow = box.bottom + 2;
    if (chipRow < 0) { root.classList.remove('on'); return; }
    track.row = chipRow;
    track.left = box.left;
    const cw = cellWidth();
    const ch = rowHeight();
    root.style.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
    root.style.top = `${Math.round(chipRow * ch)}px`;
    root.style.height = `${Math.round(2 * ch)}px`;
    root.style.lineHeight = `${ch}px`;
    shadeEl.style.top = `${-Math.round(ch * 0.6)}px`;
    chipsEl.style.height = folderEl.style.height = `${ch}px`;
    chipsEl.style.left = `${box.left * cw}px`;
    folderEl.style.top = `${Math.round(ch)}px`;
    folderEl.style.right = `${Math.round((term.cols - box.right) * cw)}px`;
    for (const slot of track.slots) {
      slot.el.style.left = `${slot.x * cw}px`;
      slot.el.style.width = `${slot.w * cw}px`;
      if (slot.sep) slot.sep.style.left = `${(slot.x + slot.w) * cw}px`;
      if (slot.sep) slot.sep.style.width = `${cw}px`;
    }
    placePill(false);
  }

  function pillRect() {
    const slot = track?.slots[track.active];
    if (!slot) return null;
    const cw = cellWidth();
    const ch = rowHeight();
    return { x: (slot.x + (track.left || 0)) * cw, y: (track.row ?? 0) * ch, w: slot.w * cw, h: ch };
  }

  function placePill(animate) {
    const slot = track.slots[track.active];
    if (!slot) { pillEl.style.opacity = '0'; return; }
    const cw = cellWidth();
    const color = mix(track.colors[track.active] || colors.fg, accentFor(track.active), 0.18);
    if (!animate) pillEl.style.transition = 'none';
    pillEl.style.opacity = '1';
    pillEl.style.transform = `translateX(${slot.x * cw}px)`;
    pillEl.style.width = `${slot.w * cw}px`;
    pillEl.style.background = color;
    pillEl.style.setProperty('--cap', `${Math.round(cw * 0.7)}px`);
    if (!animate) { void pillEl.offsetWidth; pillEl.style.transition = ''; }
    track.slots.forEach((s, i) => {
      const on = i === track.active;
      s.el.classList.toggle('active', on);
      s.el.style.color = on ? inkOn(color) : (track.colors[i] || colors.fg);
      // The highlight's pointed ends take the place of the separators beside it.
      if (s.sep) s.sep.classList.toggle('gone', on || i === track.active - 1);
    });
  }

  function build(data) {
    for (const el of chipsEl.querySelectorAll('.chip, .sep')) el.remove();
    const slots = [];
    let x = 1;
    data.labels.forEach((label, i) => {
      const el = document.createElement('span');
      el.className = 'chip';
      el.textContent = label;
      chipsEl.appendChild(el);
      const w = [...label].length + 4;
      const slot = { x, w, el, sep: null };
      x += w;
      if (i < data.labels.length - 1) {
        slot.sep = document.createElement('span');
        slot.sep.className = 'sep';
        slot.sep.textContent = '┆';
        slot.sep.style.color = colors.palette[8];
        chipsEl.appendChild(slot.sep);
        x += 1;
      }
      slots.push(slot);
    });
    return slots;
  }

  // Each session's last known track, so a reloaded page can move on the first press.
  function saveTrack() {
    if (!track || !cfg.session) return;
    try {
      const all = JSON.parse(localStorage.getItem(TRACKS_KEY) || '{}');
      delete all[cfg.session];
      all[cfg.session] = { labels: track.labels, active: confirmed, colors: track.colors, models: track.models, folder: folderEl.textContent };
      const ids = Object.keys(all);
      for (const id of ids.slice(0, Math.max(0, ids.length - 30))) delete all[id];
      localStorage.setItem(TRACKS_KEY, JSON.stringify(all));
    } catch {}
  }

  // Take a track without showing it (startup, or an answer that came after the chips were sent away).
  function quietTrack(data) {
    if (!Array.isArray(data?.labels) || !data.labels.length) return;
    if (root.classList.contains('on')) return; // the shown track is newer
    const sameRow = track && track.labels.join('\n') === data.labels.join('\n');
    track = {
      labels: data.labels.map(String),
      active: Number.isInteger(data.active) ? data.active : -1,
      colors: (data.colors || []).map((c) => (validHex(c) ? c : '')),
      models: data.models || [],
      slots: sameRow ? track.slots : build(data),
    };
    confirmed = track.active;
    folderEl.textContent = data.folder || '';
    folderEl.style.color = colors.palette[8];
    saveTrack();
  }

  function show(data) {
    if (!Array.isArray(data.labels) || !data.labels.length) return hide();
    // The chips were sent away after this press: keep its answer, don't bring them back.
    if (dismissedAt > pressedAt && performance.now() - pressedAt < ANSWER_MS) {
      clearTimeout(guessTimer);
      guesses = 0;
      quietTrack(data);
      return;
    }
    const was = track && root.classList.contains('on') ? track : null;
    const sameRow = was && was.labels.join('\n') === data.labels.join('\n');
    const from = was ? was.active : -1;
    let active = Number.isInteger(data.active) ? data.active : -1;
    confirmed = active;
    // Answers to earlier presses while later ones are already shown keep the guess.
    if (guesses > 0) {
      guesses--;
      if (guesses > 0 && sameRow) active = was.active;
      else { clearTimeout(guessTimer); guesses = 0; }
    }
    track = {
      labels: data.labels.map(String),
      active,
      colors: (data.colors || []).map((c) => (validHex(c) ? c : '')),
      models: data.models || [],
      slots: sameRow ? was.slots : build(data),
      row: was?.row,
      left: was?.left,
    };
    folderEl.textContent = data.folder || '';
    folderEl.style.color = colors.palette[8];
    saveTrack();
    const moved = !was || from !== track.active;
    root.classList.remove('away');
    if (catchingUp) { layout(); root.classList.add('on'); armHide(); return; }
    if (!was) {
      layout();
      root.classList.remove('on');
      void root.offsetWidth;
      root.classList.add('on');
    } else if (sameRow) {
      placePill(true);
    } else {
      layout();
    }
    if (moved) flourish(track.active);
    armHide();
  }

  // Ctrl+P: move to the next chip now, before r7-Harness answers.
  function guessNext() {
    if (!track || track.labels.length < 2 || track.active < 0) return;
    const shown = root.classList.contains('on');
    track.active = (track.active + 1) % track.labels.length;
    guesses++;
    root.classList.remove('away');
    if (!shown) {
      layout();
      root.classList.remove('on');
      void root.offsetWidth;
      root.classList.add('on');
    } else {
      placePill(true);
    }
    flourish(track.active);
    armHide();
    clearTimeout(guessTimer);
    guessTimer = setTimeout(() => {
      guesses = 0;
      if (!track || track.active === confirmed) return;
      track.active = confirmed;
      placePill(true);
    }, GUESS_WAIT_MS);
  }

  function armHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_AFTER_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    root.classList.remove('on');
  }

  // A key after Ctrl+P: the pick is done, so the chips and their effects go at once.
  function dismiss() {
    const pending = performance.now() - pressedAt < ANSWER_MS && dismissedAt < pressedAt;
    if (!root.classList.contains('on') && !pending && !wipe && !effects.length) return;
    dismissedAt = performance.now();
    clearTimeout(hideTimer);
    clearTimeout(guessTimer);
    guesses = 0;
    if (track) track.active = confirmed;
    root.classList.add('away');
    root.classList.remove('on');
    wipe = null;
    oldBox = null;
    wantShot = null;
    pendingWipeColor = '';
    effects = [];
    run();
  }

  // ---- the box wipe and the flourishes ---------------------------------------------

  function startWipe(color) {
    const box = findBox();
    if (!oldBox || !box || box.top !== oldBox.top || box.bottom !== oldBox.bottom) { oldBox = null; return; }
    wipe = { start: performance.now(), top: box.top, bottom: box.bottom, canvas: oldBox.canvas, color };
    oldBox = null;
    // Drawn now, inside the render that changed the box, so the new look never shows alone first.
    cancelAnimationFrame(frame);
    draw();
  }

  // The chip's name picks the flourish (a role named after its model), or else its model.
  function flourish(index) {
    const accent = accentFor(index);
    const name = String(track.labels[index] || '').replace(/\s*•\s*$/, '').toLowerCase();
    const family = modelKey(track.models?.[index]).split('-');
    const make = FLOURISHES[name] || FLOURISHES[Object.keys(FLOURISHES).find((k) => family.includes(k))];
    effects = [];
    pendingWipeColor = accent;
    if (make) effects.push({ start: performance.now(), ...make(accent) });
    run();
  }

  // Each model's own touch, in its base colour shifted toward its working colour.
  const FLOURISHES = {
    // A crescent of moonlight crosses the highlight.
    luna: (accent) => {
      const c = mix('#e4ebff', accent, 0.25);
      return {
        ms: 560,
        draw(ctx, p) {
          const r = pillRect();
          if (!r) return;
          const R = r.h * 0.62;
          const mx = r.x - R + (r.w + 2 * R) * easeInOut(p);
          const my = r.y + r.h / 2;
          ctx.save();
          // The crescent is the moon's disc with a second, offset disc cut out of it.
          ctx.beginPath();
          ctx.rect(r.x - r.h, r.y - r.h, r.w + 2 * r.h, r.h * 3);
          ctx.arc(mx - R * 0.45, my - R * 0.1, R * 0.88, 0, Math.PI * 2);
          ctx.clip('evenodd');
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = bell(p) * 0.75;
          ctx.shadowColor = c;
          ctx.shadowBlur = 12;
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(mx, my, R, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        },
      };
    },
    // A warm flare blooms out of the highlight, rays turning slightly as they fade.
    sol: (accent) => {
      const c = mix('#ffc04d', accent, 0.3);
      return {
        ms: 600,
        draw(ctx, p) {
          const r = pillRect();
          if (!r) return;
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          const e = easeOut(p);
          const fade = 1 - p;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const R = r.w * (0.45 + 1.1 * e);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
          g.addColorStop(0, rgba(c, 0.42 * fade));
          g.addColorStop(0.45, rgba(c, 0.14 * fade));
          g.addColorStop(1, rgba(c, 0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
          ctx.strokeStyle = rgba(c, 0.75 * fade);
          ctx.lineWidth = 1.5;
          ctx.lineCap = 'round';
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + e * 0.35;
            const r0 = r.w * 0.38 + r.h * 0.5 + e * r.w * 0.35;
            const r1 = r0 + r.h * (0.5 + 0.7 * (1 - e)) * (i % 2 ? 0.6 : 1);
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.55);
            ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.55);
            ctx.stroke();
          }
          ctx.restore();
        },
      };
    },
    // An ink stroke is brushed under the name, swelling in the middle, then dries away.
    opus: (accent) => {
      const c = mix('#ff6aa8', accent, 0.55);
      return {
        ms: 640,
        draw(ctx, p) {
          const r = pillRect();
          if (!r) return;
          const x0 = r.x + r.h * 0.2, x1 = r.x + r.w - r.h * 0.2;
          const y = r.y + r.h + 2.5;
          const head = easeOut(Math.min(1, p / 0.55));
          const alpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = c;
          ctx.shadowColor = c;
          ctx.shadowBlur = 6;
          const steps = 40;
          ctx.beginPath();
          for (let i = 0; i <= steps * head; i++) {
            const s = i / steps;
            const x = x0 + (x1 - x0) * s;
            const w = 0.6 + 2.4 * Math.sin(Math.PI * s) ** 0.7;
            const wobble = Math.sin(s * 9) * 0.5;
            ctx.moveTo(x + 1.6, y + wobble);
            ctx.ellipse(x, y + wobble, 1.6, w / 2, 0, 0, Math.PI * 2);
          }
          ctx.fill();
          ctx.restore();
        },
      };
    },
    // Star glints twinkle around the highlight and along the box's top edge.
    astra: (accent) => {
      const c = mix('#eefcff', accent, 0.45);
      const seed = [0.12, 0.88, 0.35, 0.62, 0.2, 0.74, 0.5];
      return {
        ms: 620,
        draw(ctx, p) {
          const r = pillRect();
          if (!r) return;
          const box = findBox();
          const ch = rowHeight();
          const spots = [
            [r.x - r.h * 0.3, r.y - r.h * 0.15], [r.x + r.w + r.h * 0.25, r.y + r.h * 0.2],
            [r.x + r.w * 0.55, r.y - r.h * 0.45], [r.x + r.w * 0.2, r.y + r.h * 1.15],
          ];
          if (box) for (let i = 0; i < 3; i++) spots.push([r.x + r.w * (0.8 + i * 1.1) + seed[i + 3] * r.w * 0.6, box.top * ch + ch * 0.5]);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = c;
          ctx.shadowColor = c;
          ctx.shadowBlur = 10;
          spots.forEach(([x, y], i) => {
            const u = (p * 620 - i * 50) / 300;
            if (u <= 0 || u >= 1) return;
            const s = bell(u) * r.h * (0.38 + seed[i] * 0.25);
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(u * 0.8);
            ctx.globalAlpha = bell(u);
            ctx.beginPath();
            ctx.moveTo(0, -s); ctx.lineTo(s * 0.16, -s * 0.16); ctx.lineTo(s, 0); ctx.lineTo(s * 0.16, s * 0.16);
            ctx.lineTo(0, s); ctx.lineTo(-s * 0.16, s * 0.16); ctx.lineTo(-s, 0); ctx.lineTo(-s * 0.16, -s * 0.16);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          });
          ctx.restore();
        },
      };
    },
  };

  let pendingWipeColor = '';

  function run() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = 0;
    const now = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const w = screenEl.clientWidth;
    const h = screenEl.clientHeight;
    if (fx.width !== Math.round(w * dpr) || fx.height !== Math.round(h * dpr)) {
      fx.width = Math.round(w * dpr);
      fx.height = Math.round(h * dpr);
      fx.style.width = `${w}px`;
      fx.style.height = `${h}px`;
    }
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fxCtx.clearRect(0, 0, w, h);
    const ch = rowHeight();
    if (wipe) {
      const p = (now - wipe.start) / WIPE_MS;
      if (p >= 1) wipe = null;
      else {
        // The old box stays right of the edge; a soft line in the working colour runs ahead of it.
        const edge = easeOut(p) * (w + 40) - 20;
        const y = wipe.top * ch;
        const hh = (wipe.bottom - wipe.top + 1) * ch;
        fxCtx.save();
        fxCtx.beginPath();
        fxCtx.rect(edge, y, w - edge, hh);
        fxCtx.clip();
        fxCtx.drawImage(wipe.canvas, 0, y, w, hh);
        fxCtx.restore();
        // The glow rides the box's top edge only.
        const a = bell(p * 0.8 + 0.1);
        const g = fxCtx.createLinearGradient(edge - 40, 0, edge, 0);
        g.addColorStop(0, rgba(wipe.color, 0));
        g.addColorStop(1, rgba(wipe.color, 0.2 * a));
        fxCtx.fillStyle = g;
        fxCtx.fillRect(edge - 40, y + ch * 0.1, 40, ch * 0.8);
        fxCtx.fillStyle = rgba(wipe.color, 0.9 * a);
        fxCtx.fillRect(edge - 1.5, y + ch * 0.1, 1.5, ch * 0.8);
      }
    }
    effects = effects.filter((e) => now - e.start < e.ms);
    for (const e of effects) e.draw(fxCtx, (now - e.start) / e.ms);
    if (wipe || effects.length) run();
  }

  // ---- wiring ---------------------------------------------------------------------

  // Ctrl+P: redraw the box once now, so its look before the switch can be copied
  // from the render (the GPU canvas can only be read right after it draws).
  document.addEventListener('keydown', (e) => {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const ctrlP = e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'p';
    const plainCtrlP = ctrlP && !e.shiftKey;
    if (ctrlP) pressedAt = performance.now();
    if (!plainCtrlP) {
      if (!ctrlP) dismiss();
      return;
    }
    const box = findBox();
    if (!box) return;
    wantShot = box;
    term.refresh(box.top, box.bottom);
    guessNext();
  }, true);

  term.onRender(() => {
    if (wantShot) {
      const box = wantShot;
      wantShot = null;
      const canvas = copyRows(box.top, box.bottom);
      oldBox = canvas ? { ...box, texts: boxTexts(box), canvas, at: performance.now() } : null;
      return;
    }
    if (oldBox && pendingWipeColor) {
      if (performance.now() - oldBox.at > 800) { oldBox = null; pendingWipeColor = ''; }
      else {
        const box = findBox();
        if (box && boxTexts(box).join('\n') !== oldBox.texts.join('\n')) {
          startWipe(pendingWipeColor);
          pendingWipeColor = '';
        }
      }
    }
    if (track && root.classList.contains('on')) layout();
  });
  term.onResize(() => { wipe = null; oldBox = null; if (track) layout(); });

  term.parser.registerOscHandler(7321, (data) => {
    if (data === 'cycle') { hide(); return true; }
    const m = /^(cycle|cycle-state|looks);(.*)$/s.exec(data);
    if (!m) return false;
    let value;
    try { value = JSON.parse(decodeURIComponent(m[2])); } catch { return true; }
    if (m[1] === 'looks') {
      looks = value;
      try { localStorage.setItem('r7.cycleLooks', JSON.stringify(value)); } catch {}
    } else if (m[1] === 'cycle-state') {
      quietTrack(value);
    } else {
      if (wantShot) wantShot = null; // the answer came before the box could be copied
      show(value);
    }
    return true;
  });

  try { quietTrack(JSON.parse(localStorage.getItem(TRACKS_KEY) || '{}')[cfg.session]); } catch {}
})();
