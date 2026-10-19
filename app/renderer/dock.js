'use strict';
// Protocol v2: helpers/jobs sit above the title; the page reserves their height.
// Placement follows findBox in onRender, not the OSC cursor or a placement timer.
// One row of equal columns; oldest cards fold to one line, then a +N chip.
const dock = (() => {
  const items = new Map(), retired = new Set(), arrived = new Set(), pills = new Map(), slots = new Set();
  const root = make('div', 'xterm-decoration xterm-decoration-top-layer r7-dock');
  const panel = make('div', 'dk-panel');
  const pillRow = make('div', 'dk-pills');
  const chip = make('div', 'dk-chip');
  chip.hidden = true;
  panel.append(chip);
  root.append(panel, pillRow);
  root.style.display = 'none';
  const LINE_H = 26; // one dock line, in 22nds of a row
  const TITLE_LIFT = .3; // the 1.3x task title grows 0.3 row up into the blank row above it
  let current = null, pending, skew = 0, skewKnown = false;
  let lastBox = null, geo = null;
  let shown = false, raf = 0, timer = 0, seed = 0, themeDrawn = '', fontDrawn = '';
  let panelWidth = 0, panelHeight = 0, panelUsedHeight = 0, panelColumns = 0, panelBottom = 0, pillSpace = 0;
  let sizesDirty = true, layoutPublished = '', publishedHeight = 0;
  const measure = document.createElement('canvas').getContext('2d');
  const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
  const smooth = (p) => { p = clamp(p); return p * p * (3 - 2 * p); };
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const mb = (n) => ((Number(n) || 0) / 1e6).toFixed(1);
  function make(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function text(el, value) {
    value = String(value ?? '');
    if (el.textContent !== value) el.textContent = value;
  }
  function style(el, key, value) { if (el.style[key] !== value) el.style[key] = value; }
  const px = (n) => `${n.toFixed(2)}px`;
  const HEX = /^#[0-9a-f]{6}$/i;
  const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const hex = (a) => '#' + a.map((n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')).join('');
  function mix(a, b, t) {
    if (!HEX.test(a)) return b;
    if (!HEX.test(b)) return a;
    const x = rgb(a), y = rgb(b);
    return hex(x.map((n, i) => n + (y[i] - n) * t));
  }
  function theme() {
    const p = colors.palette;
    const key = [colors.bg, colors.fg, colors.cursor, ...p, cfg.questionColor].join('|');
    if (key === themeDrawn) return;
    themeDrawn = key;
    const bg = HEX.test(colors.bg) ? colors.bg : '#000000';
    const fg = HEX.test(colors.fg) ? colors.fg : '#ffffff';
    const accent = HEX.test(colors.cursor) ? colors.cursor : fg;
    const dim = HEX.test(p[8]) ? p[8] : mix(bg, fg, .5);
    const yellow = HEX.test(cfg.questionColor) ? cfg.questionColor : HEX.test(p[11]) ? p[11] : '#ffc857';
    const values = {
      text: fg, bright: HEX.test(p[15]) ? p[15] : fg, bg, accent, dim,
      muted: mix(dim, fg, .5), subtle: mix(bg, dim, .4), line: accent,
      panel: mix(bg, '#000000', .85), ok: HEX.test(p[2]) ? p[2] : '#8be0a8',
      fail: HEX.test(p[1]) ? p[1] : '#e7726e', link: mix(accent, fg, .25),
      gold: yellow,
    };
    for (const [k, v] of Object.entries(values)) root.style.setProperty(`--dk-${k}`, v);
  }
  function attach() {
    if (!root.isConnected) (screenEl.querySelector('.xterm-decoration-container') || screenEl).append(root);
  }
  function fileUrl(path) {
    let p = String(path).replace(/\\/g, '/');
    const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
    if (drive) p = `${drive[1].toUpperCase()}:/${drive[2]}`;
    else if (p.startsWith('/')) return `file://wsl.localhost/${cfg.distro}` + p.split('/').map(encodeURIComponent).join('/');
    const parts = p.split('/');
    return 'file:///' + [parts[0], ...parts.slice(1).map(encodeURIComponent)].join('/');
  }
  const PATH = /([\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|json|cs|py|md|png|jpe?g|webp|gif|exe|zip|txt|cpp|c|h|css|html|sh|mp4|wav|dll))\b/g;
  function richLine(el, value) {
    let s = String(value || '');
    const lead = /^(\[\d+\/\d+\])\s?/.exec(s);
    if (lead) { el.append(make('span', 'dk-dim', lead[1] + ' ')); s = s.slice(lead[0].length); }
    if (/^(✗|error\b|fail)/i.test(s)) el.classList.add('dk-bad');
    else if (/^✓/.test(s)) el.classList.add('dk-ok');
    PATH.lastIndex = 0;
    let from = 0, m;
    while ((m = PATH.exec(s))) {
      el.append(s.slice(from, m.index), make('span', 'dk-link', m[1]));
      from = m.index + m[1].length;
    }
    el.append(s.slice(from));
  }

  // One node, two phases: the next string is installed only after the old one is invisible.
  function makeSlot() {
    const el = make('div', 'dk-slot');
    el.append(make('span', 'dk-slot-text'));
    return el;
  }
  function fillSlot(el, value, cls) {
    const line = el.firstChild;
    line.className = `dk-slot-text ${cls || ''}`;
    line.replaceChildren();
    richLine(line, value);
    el._value = value;
  }
  function setSlot(el, value, cls = '') {
    value = String(value || '');
    const key = `${cls}|${value}`;
    if (el._key === key) return;
    el._key = key;
    // A slot inside a folded (hidden) body swaps at once: animating it would run frames for nothing.
    if (el._value === undefined || !shown || document.hidden || el.closest('[hidden]')) {
      fillSlot(el, value, cls);
      el._move = null;
      slots.delete(el);
      style(el.firstChild, 'transform', '');
      style(el.firstChild, 'opacity', '1');
    } else {
      el._move = { start: Date.now(), value, cls, swapped: false };
      slots.add(el);
    }
  }
  function tickSlots(now) {
    for (const el of slots) {
      if (!el.isConnected) { slots.delete(el); continue; }
      const m = el._move, p = clamp((now - m.start) / 180), line = el.firstChild;
      if (p < .5) {
        const q = p * 2;
        style(line, 'transform', `translateY(${-100 * smooth(q)}%)`);
        style(line, 'opacity', String(clamp(1 - q * 1.5)));
      } else {
        if (!m.swapped) { fillSlot(el, m.value, m.cls); m.swapped = true; }
        const q = (p - .5) * 2;
        style(line, 'transform', `translateY(${100 * (1 - q) ** 3}%)`);
        style(line, 'opacity', String(clamp(q * 1.5 - .5)));
      }
      if (p === 1) { el._move = null; slots.delete(el); style(line, 'transform', ''); }
    }
  }
  function segments(it, total, mode) {
    if (it.barMode === mode && it.parts?.length === total) return;
    it.barMode = mode;
    it.bar.replaceChildren();
    const segs = make('div', `dk-segs${mode === 'tests' ? ' dk-tests' : ''}`);
    if (total > 100) segs.style.gap = '0px';
    it.parts = [];
    for (let i = 0; i < total; i++) {
      const s = make('span', 'dk-seg');
      s.append(make('i'));
      it.parts.push(s);
      segs.append(s);
    }
    it.bar.append(segs);
  }
  function setPlan(it, plan) {
    const total = Math.max(0, Number(plan?.total) | 0);
    if (!total) { it.bar.replaceChildren(); it.parts = null; it.barMode = ''; text(it.count, ''); return; }
    const done = clamp(Number(plan.done) || 0, 0, total);
    segments(it, total, 'plan');
    it.parts.forEach((s, i) => {
      style(s.firstChild, 'width', i < done ? '100%' : '0%');
      s.classList.toggle('cur', i === done && !it.done);
    });
    text(it.count, `${done}/${total}`);
  }
  function rail(it, fraction) {
    if (it.barMode !== 'rail') {
      it.barMode = 'rail';
      const r = make('span', 'dk-rail');
      r.append(make('i')); it.bar.replaceChildren(r); it.parts = [r.firstChild];
    }
    style(it.parts[0], 'width', `${clamp(fraction) * 100}%`);
  }
  function tests(it, d) {
    const pass = Math.max(0, d.pass | 0), fail = Math.max(0, d.fail | 0);
    // Ordered producer results are authoritative; counts are only a legacy approximation.
    if (Array.isArray(d.results)) it.results = d.results.filter((s) => s === 'pass' || s === 'fail');
    else {
      if (pass < it.pass || fail < it.fail) it.results = [];
      for (let i = it.results.filter((s) => s === 'pass').length; i < pass; i++) it.results.push('pass');
      for (let i = it.results.filter((s) => s === 'fail').length; i < fail; i++) it.results.push('fail');
    }
    it.pass = pass; it.fail = fail;
    const total = Math.max(d.total | 0, it.results.length);
    segments(it, total, 'tests');
    it.parts.forEach((s, i) => {
      s.className = `dk-seg ${it.results[i] || ''}`;
      style(s.firstChild, 'width', it.results[i] ? '100%' : '0%');
    });
    const key = `${pass}|${fail}`;
    if (it.count._key !== key) {
      it.count._key = key;
      it.count.replaceChildren(make('span', 'dk-ok', `${pass} ✓`));
      if (fail) it.count.append(make('span', 'dk-bad', ` ${fail} ✗`));
    }
  }
  function card(key, helper) {
    const fresh = !arrived.has(key);
    arrived.add(key);
    const it = { key, helper, seed: seed++ * 3, born: Date.now() - (fresh ? 0 : 240), data: null, done: false,
      doneAt: 0, exit: null, tail: [], tailPos: 0, tailTo: 0, tailAt: 0, results: [], pass: 0, fail: 0, thumbs: [] };
    if (fresh) r7.log('info', 'dock.anim', { id: key, kind: 'arrival' });
    it.wrap = make('div', 'dk-item');
    it.el = make('div', `dk-card${helper ? ' dk-helper' : ''}`);
    it.header = make('div', 'dk-header');
    it.mark = make('span', 'dk-mark');
    it.name = make('span', 'dk-name');
    it.model = make('span', 'dk-model dk-dim');
    it.bar = make('span', 'dk-bar');
    it.count = make('span', 'dk-count dk-muted');
    it.calls = make('span', 'dk-calls dk-dim');
    it.state = make('span', 'dk-state');
    it.elapsed = make('span', 'dk-clock dk-muted');
    it.button = make('button', 'dk-minimize', '–');
    it.button.type = 'button'; it.button.dataset.act = 'min';
    it.button.title = 'Minimize server'; it.button.setAttribute('aria-label', 'Minimize server');
    // A folded bar keeps the current line beside the name.
    it.inline = make('span', 'dk-inline dk-muted');
    it.header.append(it.mark, it.name, it.model, it.inline, it.bar, it.count, it.calls, it.state, it.elapsed, it.button);
    it.body = make('div', 'dk-body');
    it.action = makeSlot();
    it.fileLine = makeSlot();
    it.details = make('div', 'dk-details');
    it.details.append(it.action, it.fileLine);
    it.tailEl = make('div', 'dk-tail');
    it.frames = make('div', 'dk-frames');
    it.body.append(it.frames, it.details, it.tailEl);
    it.el.append(it.header, it.body); it.wrap.append(it.el); panel.append(it.wrap);
    return it;
  }
  function setTail(it, lines) {
    const key = JSON.stringify(lines);
    if (it.tailKey === key) return;
    it.tailKey = key;
    const now = Date.now();
    if (!it.tail.length || !shown || document.hidden) {
      it.tailEl.replaceChildren(); it.tail = [];
      it.tailPos = 0; it.tailTo = 0;
    }
    const previous = it.tail.map((r) => r.value);
    let overlap = 0;
    for (let n = Math.min(previous.length, lines.length); n > 0; n--) {
      if (previous.slice(-n).every((s, i) => s === lines[i])) { overlap = n; break; }
    }
    for (const value of lines.slice(overlap)) {
      const el = make('div', 'dk-tail-line'); richLine(el, value);
      it.tail.push({ value, el }); it.tailEl.append(el);
    }
    const target = Math.max(0, it.tail.length - it.tailRows);
    if (!previous.length) it.tailPos = target;
    it.tailFrom = it.tailPos; it.tailTo = target;
    it.tailDuration = clamp(now - (it.tailAt || now - 240), 100, 650);
    it.tailAt = now;
  }
  function tickTail(it, now) {
    if (!it.tail.length) return false;
    const p = clamp((now - it.tailAt) / it.tailDuration);
    it.tailPos = it.tailFrom + (it.tailTo - it.tailFrom) * p;
    const pitch = geo.R;
    it.tail.forEach((r, i) => {
      const y = i - it.tailPos;
      const op = y < 0 ? (it.tailRows === 1 ? 1 : .45) * (1 + y) : y <= it.tailRows - 1 ? it.tailRows === 1 ? 1 : .45 + .55 * y / (it.tailRows - 1) : it.tailRows - y;
      style(r.el, 'transform', `translateY(${px(y * pitch)})`);
      style(r.el, 'opacity', String(clamp(op)));
    });
    if (p === 1 && it.tailPos >= 1) {
      const remove = Math.floor(it.tailPos);
      it.tail.splice(0, remove).forEach((r) => r.el.remove());
      it.tailPos -= remove; it.tailTo -= remove; it.tailFrom = it.tailPos;
    }
    return p < 1 && it.tailPos !== it.tailTo;
  }
  function frames(it, d) {
    const paths = Array.isArray(d.thumbs) ? d.thumbs : [];
    const total = Math.max(paths.length, Number(d.slots?.total || d.total) || 0);
    const done = clamp(Number(d.slots?.done ?? paths.length), 0, total);
    setPlan(it, total ? { total, done } : null);
    while (it.thumbs.length > total) it.thumbs.pop().el.remove();
    for (let i = 0; i < total; i++) {
      if (!it.thumbs[i]) {
        const el = make('div', 'dk-frame');
        const mark = make('span'); el.append(mark); it.frames.append(el);
        it.thumbs.push({ el, mark, path: '' });
      }
      const th = it.thumbs[i];
      th.active = i === done && !it.done;
      if (paths[i] && paths[i] !== th.path) {
        th.path = paths[i];
        if (!th.img) { th.img = make('img', 'dk-thumb'); th.img.alt = `Frame ${i + 1}`; th.el.append(th.img); }
        th.img.src = fileUrl(paths[i]);
        th.img.title = paths[i];
        th.mark.hidden = true;
      }
      if (!th.path) {
        if (!th.active) text(th.mark, i < done ? '✓' : '');
        else if (!th.mark.firstElementChild) th.mark.replaceChildren(make('span', 'r7-ring'));
      }
    }
  }
  function update(it, d, snap) {
    it.data = d;
    it.started = Number(d.startedAt) || it.started || Date.now() - skew;
    if (d.done && !it.done) { it.done = true; it.doneAt = Date.now(); }
    const waiting = !!d.waiting && !it.done;
    it.waiting = waiting;
    it.waitStarted = Number(snap.work?.wait?.startedAt) || it.started;
    it.server = !it.helper && d.kind === 'server';
    it.gen = !it.helper && ['gen', 'render', 'frames'].includes(d.kind);
    it.el.classList.toggle('waiting', waiting);
    it.el.classList.toggle('done', it.done);
    it.el.classList.toggle('dk-server', it.server);
    it.el.classList.toggle('dk-gen', it.gen);
    const label = it.helper ? d.name || 'Helper' : d.label || ({ build: 'Building', test: 'Testing', download: 'Downloading', gen: 'Generating', server: 'Server' }[d.kind] || 'Background job');
    text(it.name, label);
    text(it.state, waiting ? 'waiting' : it.server && !/\brunning\b/i.test(label) ? `running${d.port && !label.includes(`:${d.port}`) ? ` · :${d.port}` : ''}` : '');
    text(it.model, it.helper ? d.model || '' : '');
    text(it.calls, it.helper ? `${d.calls | 0} ${(d.calls | 0) === 1 ? 'call' : 'calls'}` : '');
    it.button.hidden = it.helper || !d.persistent;
    it.button.dataset.id = d.id;
    it.tailRows = 1;
    it.details.hidden = false; it.tailEl.hidden = true; it.frames.hidden = !it.gen;
    it.fileLine.hidden = !it.gen;
    if (it.helper) {
      setPlan(it, d.plan);
      setSlot(it.action, it.done ? d.ok === false ? 'Failed · result in the transcript' : 'Done · result in the transcript' : d.action || 'Starting', it.done ? d.ok === false ? 'dk-bad' : 'dk-ok' : '');
      it.action.title = it.done && d.result ? d.result : d.action || '';
    } else {
      if (it.gen) frames(it, d);
      else if (d.kind === 'test') tests(it, d);
      else if (d.totalBytes > 0) { rail(it, (d.bytes || 0) / d.totalBytes); text(it.count, `${mb(d.bytes)}/${mb(d.totalBytes)} MB`); }
      else if (d.total > 0) { rail(it, (d.n || 0) / d.total); text(it.count, `${d.n || 0}/${d.total}`); }
      else { it.bar.replaceChildren(); it.parts = null; it.barMode = ''; text(it.count, ''); }
      const tail = (Array.isArray(d.tail) ? d.tail : []).map(String).slice(-4);
      if (it.done && !it.gen && !it.server) {
        const summary = d.kind === 'test' ? `${d.ok === false ? '✗' : '✓'} ${d.pass | 0} passed · ${d.fail | 0} failed`
          : `${d.ok === false ? '✗ Failed' : '✓ Done'} · ${clock(it.doneAt - it.started - skew)}`;
        if (tail.at(-1) !== summary) tail.push(summary);
      }
      let detail = d.detail || (it.server ? tail.at(-1) : '') || '';
      if (!detail && d.kind === 'download' && d.totalBytes > 0) detail = `${mb(d.bytes)} of ${mb(d.totalBytes)} MB`;
      if (!detail && it.gen && d.slots?.total) detail = `Frame ${Math.min((d.slots.done || 0) + 1, d.slots.total)} of ${d.slots.total} · ${it.done ? 'saved' : 'rendering'}`;
      if (it.gen) setSlot(it.fileLine, d.thumbs?.length ? String(d.thumbs.at(-1)).split(/[\\/]/).at(-1) : tail.at(-1) || '', 'dk-dim');
      if (!it.server && !it.gen && tail.length) {
        it.details.hidden = true; it.tailEl.hidden = false;
        setTail(it, tail);
      } else setSlot(it.action, detail, it.done ? d.ok === false ? 'dk-bad' : 'dk-ok' : '');
    }
    text(it.inline, !it.tailEl.hidden ? it.tail.at(-1)?.value ?? '' : it.action._move?.value ?? it.action._value ?? '');
    if (it.done) {
      it.ring = null;
      text(it.mark, d.ok === false ? '✗' : '✓');
      it.mark.className = `dk-mark ${d.ok === false ? 'dk-bad' : 'dk-ok'}`;
      for (const s of it.el.querySelectorAll('.cur')) s.classList.remove('cur');
    } else if (it.server) { it.ring = null; text(it.mark, '●'); it.mark.className = 'dk-mark dk-gold'; }
  }
  function removeItem(it) {
    it.wrap.remove(); items.delete(it.key);
    if (it.done) retired.add(it.key);
    slots.delete(it.action);
    slots.delete(it.fileLine);
  }
  function order() {
    return [...items.values()].sort((a, b) => Number(b.helper) - Number(a.helper) || a.started - b.started || a.seed - b.seed);
  }
  function reconcile(snap) {
    attach();
    sizesDirty = true;
    const now = Date.now(), seen = new Set(), minimized = new Set();
    for (const [helper, list] of [[true, snap.helpers || []], [false, snap.jobs || []]]) {
      for (const d of list) {
        const key = `${helper ? 'h' : 'j'}${d.id}`;
        seen.add(key);
        if (d.minimized) { minimized.add(key); continue; }
        if (retired.has(key) && d.done) continue;
        retired.delete(key);
        let it = items.get(key);
        if (!it) { it = card(key, helper); items.set(key, it); }
        if (it.exit) { it.exit = null; it.departed = false; }
        update(it, d, snap);
      }
    }
    for (const it of items.values()) {
      if (minimized.has(it.key) && !it.exit) it.exit = { at: now, min: true };
      else if (!seen.has(it.key) && !it.exit) it.exit = { at: it.doneAt || now, min: false };
    }
    // Move only when the helper/job ordering actually changed.
    order().forEach((it, i) => { if (panel.children[i] !== it.wrap) panel.insertBefore(it.wrap, panel.children[i] || null); });
    const wanted = (snap.jobs || []).filter(d => d.kind === 'server' && d.persistent && d.minimized && !d.done);
    const keep = new Set();
    for (const p of wanted) {
      const key = `server:${p.id}`; keep.add(key);
      let u = pills.get(key);
      if (!u) {
        const oldCard = items.get(`j${p.id}`);
        u = { el: make('button', 'dk-pill dk-pill-server'), born: now + (oldCard?.exit?.min ? 450 : 0) };
        u.mark = make('span', 'dk-gold'); u.label = make('span', 'dk-pill-label');
        u.el.append(u.mark, u.label); pillRow.append(u.el); pills.set(key, u);
      }
      u.out = 0;
      u.el.type = 'button'; u.el.dataset.act = 'min'; u.el.dataset.id = p.id;
      u.el.title = 'Restore server card'; text(u.mark, '●'); text(u.label, p.label || 'server');
    }
    for (const [key, u] of pills) if (!keep.has(key) && !u.out) u.out = now;
  }

  // Scale horizontal geometry and type by cw/9; vertical geometry by R/22.
  function geometry() {
    const cw = cellWidth(), R = rowHeight(), box = findBox();
    if (box) lastBox = box;
    const b = box || lastBox;
    const width = Math.min(screenEl.clientWidth, term.cols * cw);
    const inset = b ? b.left * cw : 0;
    const column = b ? Math.min(width - inset, (b.right - b.left + 1) * cw) : width;
    if (geo?.column !== column) sizesDirty = true;
    geo = { cw, R, x: cw / 9, y: R / 22, width, box: b, inset, column };
    const key = `${cw}|${R}|${term.options.fontSize}|${term.options.fontFamily}`;
    if (key !== fontDrawn) {
      fontDrawn = key;
      sizesDirty = true;
      root.style.fontFamily = term.options.fontFamily;
      root.style.fontSize = px(14 * geo.x);
      for (const [k, n] of Object.entries({ row: R, x: geo.x, y: geo.y })) root.style.setProperty(`--dk-${k}`, k === 'row' ? px(n) : String(n));
      measure.font = `${14 * geo.x}px ${term.options.fontFamily}`;
    }
    style(root, 'width', px(width)); style(root, 'height', px(term.rows * R));
    const titleExtra = window.r7Zoom?.titleExtra || 0;
    let bottom = 0;
    if (b) {
      bottom = (b.top - 1 - TITLE_LIFT) * R - titleExtra;
      if (typeof chromeRows === 'number' && chromeRows > 0) {
        const reserved = Math.max(Math.min(term.rows, chromeRows), term.rows - b.top);
        bottom = Math.min(bottom, (term.rows - reserved) * R - titleExtra + (window.r7TitleTrim || 0));
      }
    }
    panelBottom = Math.max(0, bottom - 6 * geo.y);
    const available = Math.max(0, panelBottom * .5);
    if (available !== panelHeight) { panelHeight = available; sizesDirty = true; }
    style(panel, 'left', px(inset));
    style(panel, 'bottom', px(term.rows * R - panelBottom));
    panel.hidden = !b;
    return b;
  }
  function measureCard(it) {
    const { y, R } = geo;
    const rows = 1;
    if (rows !== it.tailRows) {
      it.tailRows = rows;
      it.tailFrom = it.tailPos;
      it.tailTo = Math.max(0, it.tail.length - rows);
      it.tailAt = Date.now(); it.tailDuration = 180;
    }
    const bodyHeight = it.gen ? 44 * y : !it.tailEl.hidden ? it.tailRows * R : R;
    it.headerHeight = (24 + 12) * y + 2;
    it.fullHeight = it.headerHeight + bodyHeight + (!it.tailEl.hidden ? 6 * y : 0);
    style(it.tailEl, 'height', px(it.tailRows * R));
    style(it.frames, 'height', px(44 * y));
    it.el.classList.toggle('compact', term.cols < 110);
  }
  function apply(list, targets) {
    const now = Date.now();
    for (const it of list) {
      const target = targets.get(it.key), folded = target < it.fullHeight;
      if (it.height !== undefined && it.height !== target && !it.exit && !it.done && now - it.born >= 240) {
        const kind = target < it.height ? 'fold' : 'unfold';
        it.heightMove = { at: now, from: it.drawnHeight ?? it.height, to: target };
        r7.log('info', 'dock.anim', { id: it.key, kind });
      }
      it.height = target;
      it.body.hidden = folded;
      it.wrap.hidden = false;
      it.el.classList.toggle('folded', folded);
      text(it.state, folded ? it.done ? it.data.ok === false ? 'failed' : 'done' : ''
        : it.waiting ? 'waiting' : it.server && !/\brunning\b/i.test(it.name.textContent)
          ? `running${it.data.port && !it.name.textContent.includes(`:${it.data.port}`) ? ` · :${it.data.port}` : ''}` : '');
      style(it.el, 'height', px(it.height));
    }
  }
  // Fit helpers and jobs above the input box, with older overflow behind a count.
  function sizePanel() {
    if (!geo) return;
    sizesDirty = false;
    const { y } = geo, gap = 3 * y;
    const W = Math.max(0, geo.column);
    const list = order(), n = list.length;
    chip.hidden = true;
    if (!n) { panelUsedHeight = 0; return; }
    const lineH = LINE_H * y + 2;
    // Generation jobs keep their second line for the frame strip; everything else is one line.
    const height = (it) => it.gen ? it.fullHeight : lineH;
    const evict = [...list].sort((a, b) => Number(b.done) - Number(a.done) || Number(a.waiting) - Number(b.waiting)
      || a.started - b.started || a.seed - b.seed);
    for (const it of list) measureCard(it);
    let hide = 0;
    const used = (from) => evict.slice(from).reduce((sum, it) => sum + height(it) + gap, from ? lineH + gap : 0) - gap;
    while (hide < n - 1 && used(hide) > panelHeight) hide++;
    const hidden = new Set(evict.slice(0, hide));
    const visible = list.filter((it) => !hidden.has(it));
    for (const it of list) {
      it.wrap.hidden = hidden.has(it);
      if (!it.wrap.hidden) style(it.name, 'maxWidth', px(Math.max(4 * geo.cw, W * .3)));
    }
    apply(visible, new Map(visible.map((it) => [it.key, height(it)])));
    style(panel, 'width', px(W));
    style(panel, 'gridTemplateColumns', px(W));
    if (hide) {
      chip.hidden = false;
      text(chip, `+${hide} more · ${evict.slice(0, hide).map((it) => it.name.textContent).join(', ')}`);
      chip.title = chip.textContent;
      style(chip, 'height', px(lineH));
    }
    const rows = visible.length + (hide ? 1 : 0);
    panelUsedHeight = visible.reduce((sum, it) => sum + height(it), hide ? lineH : 0) + Math.max(0, rows - 1) * gap;
    panelWidth = W;
    if (panelColumns !== rows) {
      panelColumns = rows;
      r7.log('info', 'dock.layout', { session: cfg.session, rows, hidden: hide, width: W, maxHeight: panelHeight });
    }
  }
  // The shared working ring (style.css `.r7-ring`), turning in CSS while the line runs.
  function showRing(it) {
    if (it.ring?.isConnected) return;
    it.ring = make('span', 'r7-ring');
    it.mark.replaceChildren(it.ring);
  }
  function placeBottom() {
    if (!geo?.box) {
      pillRow.hidden = true;
      publishLayout(); return;
    }
    const { box: b, cw, R, x } = geo;
    const left = b.left * cw, width = (b.right - b.left + 1) * cw, title = (b.top - 1) * R;
    pillRow.hidden = false;
    style(pillRow, 'right', px(Math.max(0, geo.width - left - width)));
    style(pillRow, 'top', px(title));
    style(pillRow, 'height', px(R));
    style(pillRow, 'maxWidth', px(width * .7));
    const next = pills.size ? Math.ceil(pillRow.getBoundingClientRect().width + 12 * x) : 0;
    if (next !== pillSpace) { pillSpace = next; screenEl.style.setProperty('--r7-dock-pill-width', px(next)); }
    moveBottom();
    publishLayout();
  }
  function publishLayout(measure = true) {
    // Reserve page space for cards and minimized servers.
    let height = measure ? 0 : publishedHeight;
    if (measure && shown && geo?.box && typeof chromeRows === 'number' && chromeRows > 0) {
      const screen = screenEl.getBoundingClientRect();
      const pageBottom = screen.bottom - Math.min(term.rows, chromeRows) * geo.R + (window.r7TitleTrim || 0);
      let top = Infinity;
      if (panelUsedHeight > 0) top = Math.min(top, panelBottom - panelUsedHeight + screen.top);
      for (const el of [pillRow]) {
        if (!el || el.hidden || (el === pillRow && !pills.size)) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0) top = Math.min(top, r.top);
      }
      if (top < Infinity) height = Math.max(0, Math.ceil(pageBottom - top));
    }
    publishedHeight = height;
    const key = `${shown ? pillSpace : 0}|${height}`;
    if (key === layoutPublished) return;
    layoutPublished = key;
    window.dispatchEvent(new CustomEvent('r7-dock-layout', { detail: { height } }));
  }
  function moveBottom() {
    if (!shown || document.hidden || !geo?.box) return;
    const row = geo.box.top - 1;
    const offset = (r) => window.r7RowMotion?.(r) || 0;
    style(pillRow, 'transform', `translateY(${px(offset(row))})`);
  }
  function draw(now) {
    let moving = false, nextTick = Infinity;
    tickSlots(now); moving ||= slots.size > 0;
    let removed = false, fitted = false;
    for (const it of items.values()) {
      const enter = now - it.born;
      let opacity = smooth(enter / 240), height = smooth(enter / 240);
      if (enter < 240) moving = true;
      const end = it.exit || (it.done ? { at: it.doneAt, min: false } : null);
      if (end) {
        const t = now - end.at;
        const fade = 240, linger = end.min ? 0 : 800;
        const collapseAt = linger, collapse = 240;
        opacity *= 1 - smooth((t - linger) / fade);
        height *= 1 - smooth((t - collapseAt) / collapse);
        if (t >= linger) {
          moving = true;
          if (!it.departed) {
            it.departed = true; it.heightMove = null;
            r7.log('info', 'dock.anim', { id: it.key, kind: end.min ? 'minimize' : 'departure' });
          }
        }
        else nextTick = Math.min(nextTick, linger - t);
        if (t >= collapseAt + collapse) { removeItem(it); removed = true; continue; }
      }
      let drawnHeight = it.height;
      if (it.heightMove) {
        const m = it.heightMove, p = smooth((now - m.at) / 240);
        drawnHeight = m.from + (m.to - m.from) * p;
        if (p === 1) { it.heightMove = null; fitted = true; } else moving = true;
      }
      it.drawnHeight = drawnHeight * height;
      style(it.wrap, 'height', px(it.drawnHeight));
      style(it.wrap, 'opacity', String(opacity));
      // The ring turns in CSS; the clock needs one tick a second.
      if (!it.done && !it.server) { showRing(it); nextTick = Math.min(nextTick, 1000 - (now - it.started) % 1000); }
      const until = it.doneAt || now;
      if (!it.server || it.waiting) text(it.elapsed, clock(until - ((it.waiting ? it.waitStarted : it.started) + skew)));
      else text(it.elapsed, '');
      if (it.waiting) nextTick = Math.min(nextTick, 1000 - now % 1000);
      if (!it.body.hidden) {
        if (!it.tailEl.hidden) moving = tickTail(it, now) || moving;
      }
    }
    if (removed || fitted) { sizesDirty = true; sizePanel(); publishLayout(); }
    let pillChanged = false;
    for (const [key, u] of pills) {
      const p = u.out ? 1 - smooth((now - u.out) / 400) : smooth((now - u.born) / 400);
      style(u.el, 'opacity', String(p));
      if (u.out && p === 0) { u.el.remove(); pills.delete(key); pillChanged = true; }
      else if (!u.out && now < u.born) nextTick = Math.min(nextTick, u.born - now);
      else if (u.out || p < 1) moving = true;
    }
    if (pillChanged) { placeBottom(); term.refresh(0, term.rows - 1); }
    if (!items.size && !pills.size) {
      current = null; hide();
    }
    return moving ? 0 : Number.isFinite(nextTick) ? Math.max(1, nextTick) : -1;
  }
  function cancel() { if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); raf = timer = 0; }
  function wake() {
    cancel();
    if (!shown || document.hidden || !geo) return;
    const delay = draw(Date.now());
    if (!shown) return;
    if (delay === 0) raf = requestAnimationFrame(wake);
    else if (delay > 0) timer = setTimeout(wake, delay);
  }
  function hide() { shown = false; root.style.display = 'none'; root.classList.add('paused'); cancel(); publishLayout(); }
  function clear() {
    for (const it of items.values()) it.wrap.remove();
    items.clear(); retired.clear(); slots.clear();
    pills.clear(); pillRow.replaceChildren();
    panelWidth = 0; panelUsedHeight = 0; pillSpace = 0;
    screenEl.style.setProperty('--r7-dock-pill-width', '0px');
    publishLayout();
  }
  function place() {
    if (document.hidden) { hide(); return; }
    if (pending !== undefined) {
      current = pending || { helpers: [], jobs: [] }; pending = undefined;
      reconcile(current);
    }
    if (!current || document.hidden || term.buffer.active.type !== 'normal' || term.buffer.active.viewportY !== term.buffer.active.baseY) { hide(); return; }
    attach(); theme(); geometry();
    root.style.display = 'block'; root.classList.remove('paused'); shown = true;
    if (sizesDirty) sizePanel();
    placeBottom(); wake();
  }
  const hit = (e) => e.target.closest?.('[data-act]');
  root.addEventListener('mousedown', (e) => { if (hit(e)) { e.preventDefault(); e.stopPropagation(); } });
  root.addEventListener('mouseup', (e) => { if (hit(e)) e.stopPropagation(); });
  root.addEventListener('click', (e) => {
    const el = hit(e); if (!el) return;
    e.stopPropagation(); const id = Number(el.dataset.id);
    if (!Number.isFinite(id)) return;
    sendRaw(`\x1b[7322;2;${id}~`);
  });
  function osc(data) {
    let snap = null;
    if (data) {
      try { snap = JSON.parse(decodeURIComponent(data)); }
      catch (e) { r7.log('warn', 'dock.parse', { session: cfg.session, error: String(e.message || e) }); return; }
      if (!snap || snap.v !== 1) return;
      const reading = Date.now() - Number(snap.now);
      if (Number.isFinite(reading)) {
        skew = !skewKnown || reading < skew ? reading : skew + (reading - skew) * .1;
        skewKnown = true;
      }
    }
    pending = snap;
    // Zero-reservation snapshots need a render too, but never a separate placement clock.
    term.refresh(0, term.rows - 1);
  }
  term.onRender(place);
  window.addEventListener('r7-clear', () => {
    pending = undefined;
    current = lastBox = geo = null;
    hide();
    clear();
    arrived.clear();
    sizesDirty = true;
  });
  term.onResize(() => { lastBox = null; fontDrawn = ''; sizesDirty = true; });
  window.addEventListener('r7-row-motion', moveBottom);
  window.addEventListener('r7-view-chrome', () => { sizesDirty = true; if (shown) term.refresh(0, term.rows - 1); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); else place(); });
  snapshotListeners.push(() => { pending = undefined; current = null; lastBox = null; sizesDirty = true; hide(); });
  colorListeners.push(() => { if (shown) { theme(); publishLayout(false); } });
  return { osc, pillWidth: () => shown ? pillSpace : 0 };
})();
