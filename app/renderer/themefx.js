'use strict';
// Theme effects decorate live content. Working/resting retains its background blend masks;
// model changes commit the exact palette once, then illuminate it with the model's wave.
// Hidden windows, catch-up and reduced motion change at once. Native output never waits.

(() => {
  const STATE_MS = 380;
  const MODEL_MS = 680;
  const quiet = matchMedia('(prefers-reduced-motion: reduce)');
  const decoder = new TextDecoder();
  const PATTERNS = { opus: 1, sol: 2, sonnet: 3, fable: 4, astra: 5, luna: 6 };
  let loaded = false, effect = null, preparation = null;
  let prediction = null, previewReady = null, predictedOnce = false;
  let paletteTarget = null, pendingPalettes = 0, previewGeneration = 0;
  const paletteKeys = new WeakMap();
  const terminalColor = (terminal, key) => terminal[key] || terminal[key === 'magenta' ? 'purple' : key === 'brightMagenta' ? 'brightPurple' : key];

  function paletteKey(theme) {
    if (!theme?.terminal || !theme.roles) return null;
    if (paletteKeys.has(theme)) return paletteKeys.get(theme);
    const t = theme.terminal;
    if (![t.foreground, t.background, t.cursorColor, t.selectionBackground, ...ANSI.map((key) => terminalColor(t, key))].every((c) => !!parseColor(c || ''))) return null;
    const key = JSON.stringify([t.foreground, t.background, t.cursorColor, t.selectionBackground, ...ANSI.map((name) => terminalColor(t, name))]);
    paletteKeys.set(theme, key);
    return key;
  }

  function themeLook(theme) {
    const { background: bg, cursorColor: accent } = theme.terminal;
    return { bg, accent, changed: bg.toLowerCase() !== String(colors.bg).toLowerCase()
      || accent.toLowerCase() !== String(colors.cursor).toLowerCase() };
  }

  function previewDone(generation) {
    if (generation !== previewGeneration || !previewReady || previewReady.generation !== generation) return;
    const done = previewReady.fn;
    previewReady = null;
    done?.();
  }

  function finishPreparation() {
    const job = preparation;
    if (!job) return;
    preparation = null;
    cancelAnimationFrame(job.frame);
    job.done?.();
    previewDone(job.generation);
  }

  function prepared(generation, done, firstFrame) {
    const previous = preparation;
    if (previous) cancelAnimationFrame(previous.frame);
    const job = { generation: generation || previous?.generation || 0, done, frame: 0 };
    preparation = job;
    flushPalette();
    window.r7View?.flushTheme?.();
    keepBottom();
    // Finish palette style/paint before chip geometry and flourish work.
    if (enabled()) job.frame = requestAnimationFrame(() => {
      if (preparation !== job) return;
      firstFrame?.();
      job.frame = requestAnimationFrame(() => { if (preparation === job) finishPreparation(); });
    });
    else finishPreparation();
  }

  function ownPalette(theme, generation = 0) {
    pendingPalettes++;
    return { theme, generation };
  }

  function paletteColor(code, fallback, index) {
    const t = paletteTarget?.terminal;
    if (!t) return fallback;
    const key = { 10: 'foreground', 11: 'background', 12: 'cursorColor' }[code];
    return (code === 4 ? terminalColor(t, ANSI[index]) : t[key]) || fallback;
  }

  function preview(theme, ready) {
    if (!harness.on || !paletteKey(theme)) return false;
    const following = !!prediction || !!effect?.p.pattern;
    prediction = theme;
    paletteTarget = theme;
    predictedOnce = true;
    const generation = ++previewGeneration;
    if (ready !== undefined) previewReady = { generation, fn: ready };
    else if (previewReady) previewReady.generation = generation;
    const item = ownPalette(theme, generation);
    const look = themeLook(theme);
    stop('superseded');
    if (!following && enabled() && look.changed) start([item], look);
    else writeItems([item], prepared);
    return true;
  }

  function confirm(theme) {
    if (!prediction) {
      if (predictedOnce) window.r7View?.confirmTheme?.(theme?.roles);
      if (pendingPalettes && paletteKey(theme)) paletteTarget = theme;
      return;
    }
    const key = paletteKey(theme);
    const same = key && key === paletteKey(prediction);
    if (!same) previewReady = null;
    prediction = null;
    paletteTarget = pendingPalettes ? theme : null;
    window.r7View?.confirmTheme?.(theme?.roles);
    if (key && !same) {
      paletteTarget = theme;
      const item = ownPalette(theme);
      stop('corrected');
      writeItems([item], prepared);
    }
  }

  try { CSS.registerProperty({ name: '--fx-p', syntax: '<number>', inherits: false, initialValue: '0' }); } catch {}
  CSS.paintWorklet?.addModule('themefx-paint.js').then(() => { loaded = true; })
    .catch((err) => r7.log('warn', 'themefx.worklet', { session: cfg.session, error: String(err) }));
  const glow = document.createElement('div');
  glow.id = 'r7-themefx-glow';
  const lift = document.createElement('div');
  const sink = document.createElement('div');
  lift.className = sink.className = 'r7-themefx-shade';

  function enabled() {
    return loaded && !quiet.matches && !document.hidden && !heldBytes && !catchingUp && !!window.r7View?.active;
  }

  // Only decode bytes around OSC 11. Native xterm parsing still owns the original chunk.
  function lookIn(data) {
    let text;
    if (typeof data === 'string') {
      if (!data.includes('\x1b]11;')) return null;
      text = data;
    } else {
      let at = -1;
      for (let i = data.indexOf(0x1b); i >= 0 && i < data.length - 4; i = data.indexOf(0x1b, i + 1)) {
        if (data[i + 1] === 0x5d && data[i + 2] === 0x31 && data[i + 3] === 0x31 && data[i + 4] === 0x3b) { at = i; break; }
      }
      if (at < 0) return null;
      text = decoder.decode(data.subarray(at, Math.min(data.length, at + 2048)));
    }
    const bg = /\x1b\]11;(#[0-9a-f]{6})/i.exec(text)?.[1];
    const accent = /\x1b\]12;(#[0-9a-f]{6})/i.exec(text)?.[1];
    if (!bg) return null;
    const newBg = bg.toLowerCase() !== String(colors.bg).toLowerCase();
    const newAccent = accent && accent.toLowerCase() !== String(colors.cursor).toLowerCase();
    return { bg, accent: accent || colors.cursor || colors.fg, changed: !!(newBg || newAccent) };
  }

  function hue(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return -1;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  function near(a, b) {
    const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const [x, y] = [rgb(a), rgb(b)];
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 24;
  }

  function patternFor(accent) {
    let looks = null;
    try { looks = JSON.parse(savedValues.getItem('r7.cycleLooks') || 'null'); } catch {}
    for (const [key, color] of Object.entries(looks?.models || {})) {
      if (!/^#[0-9a-f]{6}$/i.test(color) || !near(color, accent)) continue;
      const name = Object.keys(PATTERNS).find((n) => key.includes(n));
      if (name) return PATTERNS[name];
    }
    const h = hue(accent);
    if (h < 0) return 2;
    if (h >= 350 || h < 20) return PATTERNS.sonnet;
    if (h >= 320) return PATTERNS.opus;
    if (h >= 288) return PATTERNS.fable;
    if (h >= 245) return PATTERNS.sol;
    if (h >= 190) return PATTERNS.astra;
    if (h >= 140) return PATTERNS.luna;
    return PATTERNS.sol;
  }

  function plan(look) {
    const cw = screenEl.clientWidth / term.cols, ch = screenEl.clientHeight / term.rows;
    if (!/^#[0-9a-f]{6}$/i.test(colors.cursor || '') || near(look.accent, colors.cursor)) {
      return { pattern: 0, ms: STATE_MS, x: innerWidth * 0.3, y: innerHeight + 20, accent: look.accent, cw, ch };
    }
    const box = findBox(), rect = screenEl.getBoundingClientRect();
    const at = box
      ? { x: rect.left + (box.left + 3.5) * cw, y: rect.top + (box.top + 0.5) * ch }
      : { x: innerWidth * 0.08, y: innerHeight - 40 };
    return { pattern: patternFor(look.accent), ms: MODEL_MS, ...at, accent: look.accent, cw, ch };
  }

  function stop(reason = 'cancelled') {
    const current = effect;
    if (!current) return;
    effect = null;
    for (const animation of current.animations) animation.cancel();
    lift.remove(); sink.remove(); glow.remove();
    const end = performance.now(), p = current.p;
    r7.log('info', 'themefx', {
      session: cfg.session, mode: 'live', pattern: p.pattern,
      origin: p.y < innerHeight / 2 ? 'top' : 'bottom', reason, writes: current.writes,
      ms: Math.round(end - current.started),
      writeMs: current.written ? Math.round(current.written - current.started) : null,
      firstFrameMs: current.firstFrame ? Math.round(current.firstFrame - current.started) : null,
      preparationMs: current.ready ? Math.round(current.ready - current.started) : null,
      waveMs: current.ready ? Math.round(end - current.ready) : 0,
    });
  }

  function animate(current) {
    if (effect !== current) return;
    if (!enabled()) { stop('quiet'); return; }
    current.ready = performance.now();
    const p = current.p;
    const timing = { duration: p.ms, easing: p.pattern ? 'cubic-bezier(.4,0,.25,1)' : 'cubic-bezier(.3,0,.25,1)', fill: 'both' };
    current.animations = current.layers.map((el) => el.animate({ '--fx-p': [0, 1] }, timing));
    current.animations[0].finished.then(() => {
      if (effect === current) stop('complete');
    }).catch(() => { if (effect === current) stop('cancelled'); });
  }

  function mount(current, from, to) {
    const p = current.p;
    const vars = `--fx-pattern:${p.pattern};--fx-ox:${p.x.toFixed(1)};--fx-oy:${p.y.toFixed(1)};--fx-cw:${p.cw.toFixed(2)};--fx-ch:${p.ch.toFixed(2)};--fx-color:${p.accent};`;
    const layers = [];
    if (!p.pattern && from && to) {
      for (const [el, d] of [[sink, to.map((v, i) => Math.max(0, v - from[i]))], [lift, from.map((v, i) => Math.max(0, v - to[i]))]]) {
        if (!d.some(Boolean)) continue;
        el.style.cssText = `${vars}--fx-invert:1;background:rgb(${d.join(',')});mix-blend-mode:${el === lift ? 'plus-lighter' : 'difference'}`;
        layers.push(el);
      }
    }
    glow.style.cssText = vars;
    layers.push(glow);
    current.layers = layers;
    document.body.append(...layers);
  }

  function start(items, look) {
    stop('superseded');
    const p = plan(look);
    const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const from = rgb(/^#[0-9a-f]{6}$/i.test(colors.bg) ? colors.bg : '#000000'), to = rgb(look.bg);
    const current = { p, started: performance.now(), written: 0, firstFrame: 0, ready: 0, animations: [], layers: [], writes: items.length };
    effect = current;
    writeItems(items, (generation) => {
      current.written = performance.now();
      flushPalette(); window.r7View?.flushTheme?.(); keepBottom();
      if (effect === current && enabled()) mount(current, from, to);
      prepared(generation, () => animate(current), () => { current.firstFrame = performance.now(); });
    });
  }

  // A steer keeps its palette and plays only the lit working/resting wave.
  function pulse() {
    if (!enabled() || effect) return;
    const p = { pattern: 0, ms: STATE_MS, x: innerWidth * 0.3, y: innerHeight + 20,
      accent: colors.cursor || colors.fg, cw: screenEl.clientWidth / term.cols, ch: screenEl.clientHeight / term.rows };
    const current = { p, started: performance.now(), written: 0, firstFrame: 0, ready: 0, animations: [], layers: [], writes: 0 };
    effect = current;
    mount(current);
    animate(current);
  }

  editHooks.push((data) => {
    if (effect?.p.pattern && data !== '\x10') stop();
    if (data === '\r' && window.r7Busy) pulse();
    return false;
  });

  function writeItems(items, done = keepBottom) {
    if (prediction) window.r7View?.previewTheme?.(prediction.roles);
    let generation = 0;
    for (const item of items) if (item?.theme) generation = item.generation;
    for (let i = 0; i < items.length; i++) {
      const item = items[i], owned = !!item?.theme;
      // Empty writes fence palette application without touching native parser state.
      // Submit every original chunk now so later output cannot overtake the batch.
      term.write(owned ? '' : item, () => {
        if (owned) {
          applyTerminalPalette((paletteTarget || item.theme).terminal);
          pendingPalettes--;
          if (!pendingPalettes && !prediction) paletteTarget = null;
        }
        if (i === items.length - 1) done(generation);
      });
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop('hidden'); finishPreparation(); }
  });
  window.addEventListener('r7-clear', () => {
    stop('clear');
    finishPreparation();
  });
  quiet.addEventListener('change', () => {
    if (quiet.matches) { stop('reduced-motion'); finishPreparation(); }
  });

  window.r7ThemeFx = {
    enabled,
    preview, confirm, paletteColor,
    busy: () => !!effect?.p.pattern,
    // Handled chunks are submitted unchanged and immediately; ordinary output stays native.
    take(data) {
      if (!enabled()) return false;
      const look = paletteTarget ? null : lookIn(data);
      if (!look?.changed) return false;
      start([data], look);
      return true;
    },
  };
})();
