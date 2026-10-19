'use strict';
// ---- Ctrl+P model switch ------------------------------------------------------------
// OSC 7321 cycle shows model chips; cycle-state updates them without showing them.
// The highlight moves on Ctrl+P and settles when the harness confirms its selection.
// OSC 7321 looks supplies the model colors and theme previews.

(() => {
  const HIDE_AFTER_MS = 6000; // Hide after a lost dismiss message.
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
  let lastLayout = null;
  let lastPill = null;
  let hideTimer = 0;
  let hideAt = 0;
  let shown = false;
  root.hidden = document.hidden;
  let guesses = 0; // Ctrl+P presses ahead of the harness's answers
  let confirmed = -1; // the active chip in the last answer
  let guessTimer = 0;
  let pressedAt = -Infinity; // last Ctrl+P or Ctrl+Shift+P
  let dismissedAt = -Infinity; // last key that sent the chips away
  let looks = null;
  try { looks = JSON.parse(savedValues.getItem('r7.cycleLooks') || 'null'); } catch {}

  let effects = []; // { start, ms, draw(ctx, p) }
  let frame = 0;
  let paintStats = null;

  // Point releases share one model look.
  function modelKey(id) {
    const base = String(id || '').toLowerCase().replace(/:.*$/, '').replace(/^.*\//, '');
    const family = base.split(/[-_\s]+/).filter((t) => t && !/^(?:\d+(?:\.\d+)*|latest)$/.test(t)).join('-');
    return (family || base).replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  }

  const validHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const rgbOf = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
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

  function themeFor(index) {
    if (!track?.models?.[index]) return null;
    const variants = looks?.themes?.[modelKey(track.models[index])] || looks?.fallback;
    return variants?.[window.r7Busy ? 'working' : 'idle'] || null;
  }

  function confirmTheme() {
    window.r7ThemeFx?.confirm?.(themeFor(confirmed));
  }

  const easeOut = (p) => 1 - (1 - p) ** 3;
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const bell = (p) => Math.sin(Math.PI * Math.max(0, Math.min(1, p)));

  // ---- the chips ------------------------------------------------------------------

  function layout() {
    if (document.hidden || !track || !shown) return;
    if (!track.slots) track.slots = build(track);
    if (folderEl.textContent !== track.folder) folderEl.textContent = track.folder;
    folderEl.style.color = colors.palette[8];
    const box = findBox();
    // Over the chat above the box, or under the box while the chat is still too short.
    let chipRow = box ? box.top - 4 : -1;
    if (box && chipRow < 0 && box.bottom + 3 < term.rows) chipRow = box.bottom + 2;
    if (chipRow < 0) { root.classList.remove('on'); return; }
    track.row = chipRow;
    track.left = box.left;
    const cw = cellWidth();
    const ch = rowHeight();
    const next = [track.slots, chipRow, box.left, box.right, term.cols, cw, ch, term.options.fontSize, term.options.fontFamily];
    if (lastLayout && next.every((value, i) => value === lastLayout[i])) {
      placePill(false);
      return;
    }
    lastLayout = next;
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
    const slot = track?.slots?.[track.active];
    if (!slot) return null;
    const cw = cellWidth();
    const ch = rowHeight();
    return { x: (slot.x + (track.left || 0)) * cw, y: (track.row ?? 0) * ch, w: slot.w * cw, h: ch };
  }

  function placePill(animate) {
    if (document.hidden || !shown || !track?.slots) return;
    const slot = track.slots[track.active];
    if (!slot) { lastPill = null; pillEl.style.opacity = '0'; return; }
    const cw = cellWidth();
    const accents = track.slots.map((s, i) => accentFor(i));
    const color = accents[track.active];
    const next = [track.slots, track.active, cw, ...accents];
    if (lastPill && next.length === lastPill.length && next.every((value, i) => value === lastPill[i])) return;
    lastPill = next;
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
      s.el.style.color = on ? inkOn(color) : accents[i];
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
      const all = JSON.parse(savedValues.getItem(TRACKS_KEY) || '{}');
      delete all[cfg.session];
      all[cfg.session] = { labels: track.labels, active: confirmed, colors: track.colors, models: track.models, folder: track.folder };
      const ids = Object.keys(all);
      for (const id of ids.slice(0, Math.max(0, ids.length - 30))) delete all[id];
      savedValues.setItem(TRACKS_KEY, JSON.stringify(all));
    } catch {}
  }

  // Take a track without showing it (startup, or an answer that came after the chips were sent away).
  function quietTrack(data) {
    if (!Array.isArray(data?.labels) || !data.labels.length) return;
    if (shown) return; // the shown track is newer
    const sameRow = track && track.labels.join('\n') === data.labels.join('\n');
    track = {
      labels: data.labels.map(String),
      active: Number.isInteger(data.active) ? data.active : -1,
      colors: (data.colors || []).map((c) => (validHex(c) ? c : '')),
      models: data.models || [],
      folder: data.folder || '',
      slots: sameRow ? track.slots : null,
    };
    confirmed = track.active;
    confirmTheme();
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
    const was = track && shown ? track : null;
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
      folder: data.folder || '',
      slots: sameRow ? was.slots : document.hidden ? null : build(data),
      row: was?.row,
      left: was?.left,
    };
    if (!guesses) confirmTheme();
    saveTrack();
    shown = true;
    if (document.hidden) { armHide(); return; }
    folderEl.textContent = track.folder;
    folderEl.style.color = colors.palette[8];
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
    if (moved) flourish(track.labels[track.active], accentFor(track.active));
    armHide();
  }

  // Move to the next chip before the harness answers.
  function guessNext() {
    if (!track || track.labels.length < 2 || track.active < 0) return;
    const wasShown = shown;
    shown = true;
    track.active = (track.active + 1) % track.labels.length;
    guesses++;
    const target = track.active, press = pressedAt;
    const animate = () => {
      if (document.hidden || !shown || track?.active !== target || pressedAt !== press) return;
      root.classList.remove('away');
      if (!wasShown) {
        layout();
        root.classList.remove('on');
        void root.offsetWidth;
        root.classList.add('on');
      } else {
        placePill(true);
      }
      flourish(track.labels[track.active], accentFor(track.active));
    };
    if (!window.r7ThemeFx?.preview?.(themeFor(target), animate)) animate();
    armHide();
    clearTimeout(guessTimer);
    guessTimer = setTimeout(() => {
      guesses = 0;
      confirmTheme();
      if (!track || track.active === confirmed) return;
      track.active = confirmed;
      placePill(true);
    }, GUESS_WAIT_MS);
  }

  function armHide() {
    clearTimeout(hideTimer);
    hideAt = performance.now() + HIDE_AFTER_MS;
    hideTimer = setTimeout(hide, HIDE_AFTER_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    clearTimeout(guessTimer);
    guesses = 0;
    confirmTheme();
    if (track) track.active = confirmed;
    shown = false;
    hideAt = 0;
    root.classList.remove('on');
    stopEffects();
  }

  // A key after Ctrl+P: the pick is done, so the chips and their effects go at once.
  function dismiss() {
    const pending = performance.now() - pressedAt < ANSWER_MS && dismissedAt < pressedAt;
    if (!shown && !pending && !effects.length) return;
    dismissedAt = performance.now();
    clearTimeout(hideTimer);
    clearTimeout(guessTimer);
    guesses = 0;
    confirmTheme();
    if (track) track.active = confirmed;
    shown = false;
    hideAt = 0;
    root.classList.add('away');
    root.classList.remove('on');
    stopEffects();
  }

  // ---- the flourishes -------------------------------------------------------------

  function flourish(label, accent) {
    if (document.hidden) return;
    const kind = String(label || '').replace(/\s*•\s*$/, '').toLowerCase();
    const make = FLOURISHES[kind];
    effects = [];
    if (make) effects.push({ start: performance.now(), ...make(accent) });
    paintStats = { started: performance.now(), frames: 0, cpuMs: 0, maxGapMs: 0, last: 0, firstMs: 0 };
    run();
  }

  // Each model's own touch, in its working colour.
  const FLOURISHES = {
    // A crescent of moonlight crosses the highlight.
    luna: (accent) => {
      const c = accent;
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
    // A flare blooms out of the highlight, rays turning slightly as they fade.
    sol: (accent) => {
      const c = accent;
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
      const c = accent;
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
      const c = accent;
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

  function stopEffects() {
    cancelAnimationFrame(frame);
    frame = 0;
    effects = [];
    paintStats = null;
    fxCtx.setTransform(1, 0, 0, 1, 0, 0);
    fxCtx.clearRect(0, 0, fx.width, fx.height);
  }

  function run() {
    if (!document.hidden && !frame) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = 0;
    if (document.hidden) { stopEffects(); return; }
    const now = performance.now();
    effects = effects.filter((e) => now - e.start < e.ms);
    if (!effects.length) {
      fxCtx.setTransform(1, 0, 0, 1, 0, 0);
      fxCtx.clearRect(0, 0, fx.width, fx.height);
      if (paintStats?.frames) r7.log('info', 'cycle.paint', {
        session: cfg.session, frames: paintStats.frames,
        firstMs: Math.round(paintStats.firstMs),
        maxGapMs: Math.round(paintStats.maxGapMs),
        cpuMs: Math.round(paintStats.cpuMs * 10) / 10,
        pixels: fx.width * fx.height,
      });
      paintStats = null;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = screenEl.clientWidth;
    const screenH = screenEl.clientHeight;
    const ch = rowHeight();
    const pill = pillRect();
    // Sol's radial flare is the largest chip effect; keep its full radius and shadows.
    // Astra also lights the box edge. Nothing here needs a full-window backing store.
    const radius = pill ? Math.max(pill.w * 1.55, pill.h * 2) + 32 : 0;
    const box = findBox();
    let top = pill ? pill.y + pill.h / 2 - radius : screenH;
    let bottom = pill ? pill.y + pill.h / 2 + radius : 0;
    if (box && effects.length) {
      top = Math.min(top, box.top * ch - ch - 32);
      bottom = Math.max(bottom, (box.top + 2) * ch + 32);
    }
    const topPx = Math.max(0, Math.floor(top * dpr));
    const bottomPx = Math.min(Math.round(screenH * dpr), Math.ceil(bottom * dpr));
    const heightPx = Math.max(1, bottomPx - topPx);
    if (fx.width !== Math.round(w * dpr) || fx.height !== heightPx) {
      fx.width = Math.round(w * dpr);
      fx.height = heightPx;
      fx.style.width = `${w}px`;
      fx.style.height = `${heightPx / dpr}px`;
    }
    fx.style.top = `${topPx / dpr}px`;
    fxCtx.setTransform(1, 0, 0, 1, 0, 0);
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, -topPx);
    for (const e of effects) e.draw(fxCtx, (now - e.start) / e.ms);
    if (paintStats) {
      if (!paintStats.frames) paintStats.firstMs = now - paintStats.started;
      if (paintStats.last) paintStats.maxGapMs = Math.max(paintStats.maxGapMs, now - paintStats.last);
      paintStats.last = now;
      paintStats.frames++;
      paintStats.cpuMs += performance.now() - now;
    }
    run();
  }

  // ---- wiring ---------------------------------------------------------------------

  // The input box stays live even when model illumination is unavailable or disabled.
  document.addEventListener('keydown', (e) => {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const ctrlP = e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'p';
    const plainCtrlP = ctrlP && !e.shiftKey;
    if (ctrlP) pressedAt = performance.now();
    if (!plainCtrlP) {
      if (!ctrlP) dismiss();
      return;
    }
    guessNext();
  }, true);

  term.onRender(() => {
    if (document.hidden) return;
    if (track && root.classList.contains('on')) layout();
  });
  term.onResize(() => { stopEffects(); layout(); });
  window.addEventListener('r7-clear', () => {
    dismiss();
    for (const animation of root.getAnimations({ subtree: true })) animation.cancel();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      root.hidden = true;
      clearTimeout(guessTimer);
      guesses = 0;
      confirmTheme();
      if (track) track.active = confirmed;
      stopEffects();
      return;
    }
    if (shown && performance.now() >= hideAt) hide();
    root.hidden = false;
    if (!shown) return;
    layout();
    root.classList.remove('away');
    root.classList.add('on');
    // Resume the current choice, not its entry or highlight transition.
    for (const animation of root.getAnimations({ subtree: true })) animation.finish();
  });

  window.addEventListener('r7-busy', () => {
    if (guesses) window.r7ThemeFx?.preview?.(themeFor(track?.active));
    else window.r7View?.confirmTheme?.(null);
  });

  term.parser.registerOscHandler(7321, (data) => {
    if (data === 'cycle') { hide(); return true; }
    const m = /^(cycle|cycle-state|looks);(.*)$/s.exec(data);
    if (!m) return false;
    let value;
    try { value = JSON.parse(decodeURIComponent(m[2])); } catch { return true; }
    if (m[1] === 'looks') {
      looks = value;
      try { savedValues.setItem('r7.cycleLooks', JSON.stringify(value)); } catch {}
      if (track) placePill(false);
    } else if (m[1] === 'cycle-state') {
      quietTrack(value);
    } else {
      show(value);
    }
    return true;
  });

  try { quietTrack(JSON.parse(savedValues.getItem(TRACKS_KEY) || '{}')[cfg.session]); } catch {}
})();
