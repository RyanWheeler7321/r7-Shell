'use strict';
// Draw the session's pictures and controls above the terminal.

(() => {
  const TOP = 14; // under the top bar
  const BELOW = 10; // between the panel and the terminal
  const GAP = 8;
  const ROWS = 4; // column cells: Play and three views
  const CELL = (16 / 9) / ROWS; // column width per pixel of panel height, past its gaps
  const MAX_W = 818; // maximum width of the main view and column
  const MAX_SHARE = 0.32; // of the window's height, gaps included
  const MIN_W = 420;
  const MIN_H = 96;
  const PRESS_MS = 400; // a second press of the same button inside this is a double-click
  const EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  const S = {
    root: null, main: null, col: null, play: null, buttons: null, views: [], note: null,
    state: null, hasMain: false, hasCol: false, size: '', height: -1, buttonSig: '', pressed: new Map(),
  };

  function fileUrl(p) {
    p = p.replace(/\\/g, '/');
    if (p.startsWith('//')) return 'file://' + p.slice(2).split('/').map(encodeURIComponent).join('/');
    const parts = p.split('/');
    return 'file:///' + [parts[0], ...parts.slice(1).map(encodeURIComponent)].join('/');
  }

  function div(className) {
    const el = document.createElement('div');
    if (className) el.className = className;
    return el;
  }

  function swallow(e) {
    e.stopPropagation();
    // Keeps focus in the terminal.
    e.preventDefault();
  }

  const padding = () => (Number.isFinite(Number(cfg.padding)) ? Number(cfg.padding) : 18);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // A picture with its caption or label; key is the file and version it shows or loads.
  function makeFrame(className, textClass) {
    const el = div(`${className} empty`);
    const img = document.createElement('img');
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    const text = div(textClass);
    text.hidden = true;
    el.append(img, text);
    return { el, img, text, key: '' };
  }

  function makePlay() {
    const el = div('r7-panel-play');
    el.setAttribute('role', 'button');
    const note = div('r7-panel-note');
    note.hidden = true;
    el.append(div('r7-panel-tri'), div('r7-panel-stop'), note);
    // The pressed look follows the button itself; :active alone may not show while the
    // pointer events are swallowed.
    el.addEventListener('pointerdown', (e) => { if (e.button === 0) el.classList.add('down'); });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(type, () => el.classList.remove('down'));
    return { el, note };
  }

  function mount() {
    if (S.root) return;
    const root = div('');
    root.id = 'r7-panel';
    root.style.setProperty('--r7-accent', window.r7Accent || colors.cursor || colors.fg);
    const main = makeFrame('r7-panel-main', 'r7-panel-caption');
    const col = div('r7-panel-col');
    const play = makePlay();
    const buttons = div('r7-panel-buttons');
    // Keep the column left of the main view and spare width on the left.
    root.append(col, main.el);
    root.addEventListener('click', onClick);
    root.addEventListener('animationend', (e) => e.target.classList.remove('press'));
    for (const type of EVENTS) root.addEventListener(type, swallow);
    const term = document.getElementById('term');
    if (term) term.after(root); else document.body.append(root);
    Object.assign(S, { root, main, col, play: play.el, note: play.note, buttons, views: [], size: '', buttonSig: '' });
    window.addEventListener('resize', layout);
  }

  function unmount() {
    if (!S.root) return;
    clearInterval(S.buildTick);
    window.removeEventListener('resize', layout);
    S.root.remove();
    // Late decodes of the old frames find their key gone and do nothing.
    for (const f of [S.main, ...S.views]) f.key = '';
    Object.assign(S, { root: null, main: null, col: null, play: null, buttons: null, views: [], note: null, state: null, size: '', buttonSig: '' });
    setHeight(0);
  }

  function setHeight(px) {
    if (px === S.height) return;
    S.height = px;
    document.documentElement.style.setProperty('--r7-panel-h', `${px}px`);
    // The pins sit under the panel and size their column to the room left.
    window.dispatchEvent(new Event('r7-panel-h'));
  }

  // Sized from the window alone, never from #term, so
  // the two never feed each other. The column's four 16:9 cells and their gaps stack to
  // exactly the main view's height, and it keeps that width with fewer cells. Main view
  // and column together fill the window's width up to MAX_W. Without a main view (nothing
  // rendered yet) the column's cells stand alone at the same size.
  function layout() {
    if (!S.root) return;
    const pad = padding();
    const width = Math.min(window.innerWidth - 2 * pad, MAX_W);
    const aspect = clamp(Number(S.state.aspect) || 16 / 9, 1, 2.4);
    const fit = S.hasCol ? (width - GAP + (ROWS - 1) * GAP * CELL) / (aspect + CELL) : width / aspect;
    let h = Math.floor(Math.min(fit, window.innerHeight * MAX_SHARE - TOP - BELOW));
    const show = window.innerWidth >= MIN_W && h >= MIN_H;
    if (S.root.hidden !== !show) S.root.hidden = !show;
    let panelH = 0;
    if (show) {
      let mainW = S.hasMain ? Math.round(h * aspect) : 0;
      let colW = S.hasCol ? Math.round((h - (ROWS - 1) * GAP) * CELL) : 0;
      // Filling the width: the column takes the rounding so both edges line up with the terminal's.
      if (S.hasMain && S.hasCol && h === Math.floor(fit)) colW = width - GAP - mainW;
      if (S.hasMain && !S.hasCol && h === Math.floor(fit)) mainW = width;
      const cells = S.col.children.length;
      const cellH = (h - (ROWS - 1) * GAP) / ROWS;
      panelH = S.hasMain ? h : Math.round(cells * cellH + (cells - 1) * GAP);
      const size = `${pad},${panelH},${mainW},${colW},${cells}`;
      if (size !== S.size) {
        S.size = size;
        Object.assign(S.root.style, {
          right: `${pad}px`, top: `${TOP}px`, height: `${panelH}px`,
          gridTemplateColumns: [colW, mainW].filter(Boolean).map((w) => `${w}px`).join(' '),
        });
        S.col.style.gridTemplateRows = S.hasMain ? '' : `repeat(${cells}, minmax(0, 1fr))`;
      }
    }
    setHeight(show ? Math.max(0, TOP + panelH + BELOW - pad) : 0);
  }

  function onClick(e) {
    if (e.button !== 0) return;
    const button = e.target.closest && e.target.closest('.r7-panel-play, .r7-panel-button');
    if (button) {
      const id = button === S.play ? S.state && S.state.play && S.state.play.id : button.dataset.id;
      if (id != null) press(button, String(id));
      return;
    }
    const frame = e.target.closest && e.target.closest('.r7-panel-main, .r7-panel-view');
    if (frame && frame.dataset.file) r7.openPath(frame.dataset.file);
  }

  function press(el, id) {
    const now = performance.now();
    if (now - (S.pressed.get(id) || 0) < PRESS_MS) return;
    S.pressed.set(id, now);
    el.classList.remove('press');
    void el.offsetWidth; // restarts the press animation
    el.classList.add('press');
    // main.js starts or stops Play from its own running state.
    r7.panelClick(id);
  }

  // The new picture is decoded off to the side and swapped in whole, so an update never
  // shows a blank or half-drawn frame; the same file and version is never loaded again.
  function setImage(f, file, version, which) {
    const key = `${file || ''}|${version || 0}`;
    if (f.key === key) return;
    f.key = key;
    f.el.dataset.file = file || '';
    if (!file || !version) {
      f.img.removeAttribute('src');
      f.el.classList.add('empty');
      return;
    }
    const url = `${fileUrl(file)}?v=${version}`;
    const t0 = performance.now();
    const next = new Image();
    next.decoding = 'async';
    next.src = url;
    next.decode().then(() => {
      if (f.key !== key) return;
      f.img.src = url;
      f.el.classList.remove('empty');
      r7.log('info', 'panel.shown', { session: cfg.session, which, ms: Math.round(performance.now() - t0), w: next.naturalWidth, h: next.naturalHeight });
    }, () => {
      if (f.key !== key) return;
      f.img.removeAttribute('src');
      f.el.classList.add('empty');
      r7.log('warn', 'panel.image_error', { session: cfg.session, which, url });
    });
  }

  function setText(f, value) {
    const s = String(value || '');
    if (f.text.textContent !== s) f.text.textContent = s;
    if (f.text.hidden !== !s) f.text.hidden = !s;
  }

  // Frames already showing a view's file and version keep it wherever it moved; the rest
  // reuse a leftover frame (its old picture stays until the new one is decoded).
  function renderViews(list) {
    const keyOf = (v) => `${v.file || ''}|${v.version || 0}`;
    const free = S.views.slice();
    const frames = list.map((v) => {
      const i = free.findIndex((f) => f.key === keyOf(v));
      return i < 0 ? null : free.splice(i, 1)[0];
    });
    S.views = list.map((v, i) => {
      const f = frames[i] || free.shift() || makeFrame('r7-panel-view', 'r7-panel-label');
      setImage(f, v.file, v.version, `view${i + 1}`);
      setText(f, v.label);
      return f;
    });
    for (const f of free) { f.key = ''; f.el.remove(); }
  }

  function renderButtons(list, running) {
    const sig = JSON.stringify(list.map((b) => [b.id, b.label]));
    if (sig !== S.buttonSig) {
      S.buttonSig = sig;
      S.buttons.replaceChildren(...list.map((b) => {
        const el = div('r7-panel-button');
        el.setAttribute('role', 'button');
        el.dataset.id = b.id;
        el.textContent = b.label || b.id;
        return el;
      }));
    }
    const on = new Set(running || []);
    for (const el of S.buttons.children) el.classList.toggle('running', on.has(el.dataset.id));
  }

  function put(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  // state: null or { aspect, main: { file, version, caption },
  // views: [{ file, version, label }], play: { id, running, starting, error }, buttons: [{ id, label }],
  // running: [id] }.
  function render(state) {
    const play = (state && state.play) || null;
    const views = (state && Array.isArray(state.views) ? state.views : []).filter((v) => v && typeof v === 'object');
    const buttons = (state && Array.isArray(state.buttons) ? state.buttons : [])
      .filter((b) => b && b.id != null && !(play && String(b.id) === String(play.id)));
    const main = (state && state.main && state.main.file) ? state.main : null; // an empty frame never shows
    if (!state || !(main || play || views.length || buttons.length)) { unmount(); return; }
    mount();
    S.state = state;

    S.hasMain = !!main;
    if (S.main.el.hidden !== !main) S.main.el.hidden = !main;
    setImage(S.main, main && main.file, main && main.version, 'main');
    setText(S.main, main && main.caption);

    // Column: Play, views, then the other buttons in one cell; views give way to them.
    const room = ROWS - (play ? 1 : 0) - (buttons.length ? 1 : 0);
    renderViews(views.slice(0, Math.max(0, room)));
    clearInterval(S.buildTick);
    S.buildTick = 0;
    if (play) {
      S.play.classList.toggle('playing', !!play.running);
      const building = !!play.starting && !play.running;
      const failed = !building && !play.running && !!play.error;
      S.play.classList.toggle('building', building);
      S.play.classList.toggle('failed', failed);
      // A build counts its seconds, so a slow one reads as working, not stuck.
      const note = () => building ? `Building… ${Math.max(0, Math.round((Date.now() - play.starting) / 1000))}s` : failed ? String(play.error) : '';
      put(S.note, note());
      if (S.note.hidden !== !note()) S.note.hidden = !note();
      if (building) S.buildTick = setInterval(() => put(S.note, note()), 1000);
    }
    renderButtons(buttons, state.running);
    const cells = [...(play ? [S.play] : []), ...S.views.map((f) => f.el), ...(buttons.length ? [S.buttons] : [])];
    const kids = S.col.children;
    if (cells.length !== kids.length || cells.some((el, i) => kids[i] !== el)) S.col.replaceChildren(...cells);
    S.hasCol = cells.length > 0;
    if (S.col.hidden !== !S.hasCol) S.col.hidden = !S.hasCol;
    layout();
  }

  r7.onPanel?.(render);
})();
