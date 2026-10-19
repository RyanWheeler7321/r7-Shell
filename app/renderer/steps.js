'use strict';
// Transcript marks for the harness's work display:
// `band` (code pane map with a gliding lens), `thumbs` (filmstrip) and `map` (read range
// of a file at a row's right end). marks.js routes the OSCs here through handleStepMark;
// like titles and pictures they are placed in every render (never on a timer), sit in the
// decoration layer so fade.js glides them with the text, and go away once their rows are
// redrawn with other text. The terminal's text itself stays plain cells.

(() => {
  const thumbErrors = new Set();
  const MAP_COLS = 24;
  const marks = [];

  const rowText = (y) => term.buffer.active.getLine(y)?.translateToString(true) ?? null;
  const cw = () => screenEl.clientWidth / term.cols;

  function fileUrl(path) {
    let p = path.replace(/\\/g, '/');
    if (/^file:\/\//i.test(p)) return p;
    const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
    if (drive) p = `${drive[1].toUpperCase()}:/${drive[2]}`;
    else if (p.startsWith('//')) {
      const [host, ...parts] = p.slice(2).split('/');
      return `file://${host}/` + parts.map(encodeURIComponent).join('/');
    } else if (p.startsWith('/')) {
      return `file://wsl.localhost/${encodeURIComponent(cfg.distro)}` + p.split('/').map(encodeURIComponent).join('/');
    }
    const parts = p.split('/');
    return 'file:///' + [parts[0], ...parts.slice(1).map(encodeURIComponent)].join('/');
  }

  // Theme colours as CSS variables, so every theme works without a redraw.
  function themeVars() {
    const root = document.documentElement.style;
    root.setProperty('--sm-fg', colors.fg);
    root.setProperty('--sm-warn', colors.palette[11] || colors.palette[3] || '#ffc857');
  }
  colorListeners.push(themeVars);
  themeVars();

  const el = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent?.append(e);
    return e;
  };

  function parseJson(raw) {
    try { return JSON.parse(decodeURIComponent(raw)); } catch { /* plain JSON */ }
    try { return JSON.parse(raw); } catch { return null; }
  }

  function drop(mark) {
    mark.el?.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    mark.el?.remove();
    mark.marker.dispose();
    const i = marks.indexOf(mark);
    if (i >= 0) marks.splice(i, 1);
  }

  const smooth = 'cubic-bezier(.333333,0,.666667,1)';
  const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
  const number = (n) => Math.round(n).toLocaleString('en-US');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function animate(node, frames, duration, delay = 0, elapsed = 0) {
    if (document.hidden || reducedMotion.matches || elapsed >= duration + delay || !node.isConnected || node.closest('.r7-steps')?.style.display === 'none') return;
    const motion = node.animate(frames, { duration, delay, easing: smooth, fill: 'backwards' });
    if (elapsed > 0) motion.currentTime = elapsed;
  }

  function settleMotion(mark) {
    mark.el?.getAnimations({ subtree: true }).forEach((a) => a.finish());
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const mark of marks) {
        settleMotion(mark);
        if (mark.el) mark.el.style.display = 'none';
      }
    }
    else placeStepMarks();
  });

  // ---- band ------------------------------------------------------------------------
  function drawBand(mark) {
    const d = mark.data;
    const total = Math.max(1, Number(d.total) || 1);
    const rowPx = rowHeight();
    const scale = rowPx / 22;
    const pad = 8 * scale;
    const W = Math.max(1, mark.el.clientWidth - pad * 2);
    const H = mark.rows * rowPx;
    const labelH = mark.rows >= 2 ? rowPx : 0;
    const fanH = mark.rows >= 4 ? 16 * scale : 0;
    const barH = Math.max(2, Math.min(44 * scale, H - labelH - fanH - 6 * scale));
    const top = 4 * scale + labelH;
    const geo = `${rowPx}|${W}|${mark.rows}`;
    let v = mark.view;
    if (!v) {
      mark.el.replaceChildren();
      v = mark.view = {
        bars: el('div', 'sm-bars', mark.el), tags: el('div', 'sm-tags', mark.el),
        shadeA: el('div', 'sm-shade', mark.el), shadeB: el('div', 'sm-shade', mark.el),
        lens: el('div', 'sm-lens', mark.el), fan: el('div', 'sm-fan', mark.el), content: '', geo: '',
      };
    }
    const snap = v.geo !== geo;
    mark.el.classList.toggle('sm-snap', snap);
    mark.dkey ??= JSON.stringify([total, d.bars, d.marks, d.changed]);
    const content = geo + mark.dkey;
    if (content !== v.content) {
      v.content = content;
      drawBandContent(mark, v, { total, W, labelH, barH, pad, top, scale });
    }
    v.geo = geo;
    const [a, b] = Array.isArray(d.lens) ? d.lens : [1, 1];
    const lo = clamp((a - 1) / total);
    const hi = clamp(b / total, lo);
    const left = lo * W;
    const width = Math.min(W - left, Math.max(4, (hi - lo) * W));
    for (const node of [v.lens, v.shadeA, v.shadeB]) {
      node.style.top = `${top}px`;
      node.style.height = `${barH}px`;
    }
    v.lens.style.left = `${pad + left}px`;
    v.lens.style.width = `${width}px`;
    v.lens.classList.toggle('moving', !!d.lens_moving);
    v.shadeA.style.left = `${pad}px`;
    v.shadeA.style.width = `${left}px`;
    v.shadeB.style.left = `${pad + left + width}px`;
    v.shadeB.style.width = `${Math.max(0, W - left - width)}px`;
    v.fan.style.cssText = `left:${pad}px;top:${top + barH}px;width:${W}px;height:${fanH}px;clip-path:polygon(${lo * 100}% 0,${hi * 100}% 0,100% 100%,0 100%)`;
    if (snap) {
      v.lens.offsetWidth;
      mark.el.classList.remove('sm-snap');
    }
  }

  function drawBandContent(mark, v, { total, W, labelH, barH, pad, top, scale }) {
    const d = mark.data;
    const source = Array.isArray(d.bars) ? d.bars : [];
    const bars = source.length <= 8192 ? source : Array.from({ length: 8192 }, (_, i) => {
      let height = 0;
      for (let j = Math.floor(i * source.length / 8192); j < Math.floor((i + 1) * source.length / 8192); j++) height = Math.max(height, Number(source[j]) || 0);
      return height;
    });
    const changed = Array.isArray(d.changed) ? d.changed : [];
    v.bars.style.cssText = `left:${pad}px;right:${pad}px;top:${top}px;height:${barH}px`;
    const frag = document.createDocumentFragment();
    bars.forEach((h, i) => {
      const from = (i * total) / bars.length + 1;
      const to = ((i + 1) * total) / bars.length;
      const lit = changed.some((r) => Array.isArray(r) && r[0] <= to && r[1] >= from);
      const bar = el('div', lit ? 'sm-bar lit' : 'sm-bar');
      const height = lit ? 1 : clamp(Number(h) || 0);
      bar.style.cssText = `left:${(i + 0.2) / bars.length * 100}%;width:${0.6 / bars.length * 100}%;height:${height ? Math.max(2, height * barH) : 0}px`;
      frag.append(bar);
    });
    v.bars.replaceChildren(frag);
    v.tags.replaceChildren();
    if (!labelH || !Array.isArray(d.marks)) return;
    v.tags.style.cssText = `left:${pad}px;right:${pad}px;top:${4 * scale}px;height:${labelH}px;font-size:${14 * scale}px`;
    const glyph = cw() * 14 / 15;
    let edge = -Infinity;
    for (const m of [...d.marks].sort((p, q) => p.line - q.line)) {
      const label = `▾${m.name ?? ''}`;
      const wide = label.length * glyph;
      const x = Math.max(0, Math.min(((m.line - 1) / total) * W - glyph * 0.5, W - wide));
      if (x < edge + glyph) continue;
      edge = x + wide;
      const tag = el('span', 'sm-tag', v.tags);
      tag.textContent = label;
      tag.style.left = `${x.toFixed(1)}px`;
    }
  }

  // ---- thumbs ----------------------------------------------------------------------
  function cropBox(tile) {
    const crop = tile.item.crop;
    if (!Array.isArray(crop) || crop.length !== 4) {
      tile.crop?.remove();
      tile.crop = null;
      tile.cropKey = '';
      return;
    }
    const frac = crop.every((n) => n >= 0 && n <= 1);
    const nw = frac ? 1 : tile.img.naturalWidth || tile.item.width;
    const nh = frac ? 1 : tile.img.naturalHeight || tile.item.height;
    if (!nw || !nh) return;
    const key = JSON.stringify([crop, nw, nh]);
    if (tile.cropKey === key) return;
    tile.cropKey = key;
    const fresh = !tile.crop;
    const box = tile.crop ||= el('div', 'sm-crop', tile.clip);
    if (fresh) for (let i = 0; i < 4; i++) el('i', `sm-handle h${i}`, box);
    const x = clamp(crop[0] / nw), y = clamp(crop[1] / nh);
    const width = `${clamp(crop[2] / nw, 0, 1 - x) * 100}%`;
    const height = `${clamp(crop[3] / nh, 0, 1 - y) * 100}%`;
    box.style.left = `${x * 100}%`;
    box.style.top = `${y * 100}%`;
    box.style.width = width;
    box.style.height = height;
    if (fresh) {
      const startedAt = Number(tile.view.owner.data.startedAt);
      const elapsed = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
      animate(box, [{ width: '0%', height: '0%', opacity: 0 }, { width, height, opacity: 1 }], 1100, 0, elapsed);
      animate(box, [{ borderColor: 'var(--r7-accent)' }, { borderColor: '#fff' }], 1100, 0, elapsed);
      for (const handle of box.children) animate(handle, [{ opacity: 0 }, { opacity: 1 }], 200, 1000, elapsed);
    }
  }

  function makeThumb(v, item, delay) {
    const slot = el('div', 'sm-slot');
    const wrap = el('div', 'sm-thumb', slot);
    const clip = el('div', 'sm-clip', wrap);
    const img = el('img', '', clip);
    const tile = {
      slot, wrap, clip, img, item, delay, view: v,
      index: el('span', 'sm-index', wrap), label: el('span', 'sm-label', wrap),
      ring: el('span', 'sm-ring', wrap), crop: null,
    };
    img.dataset.path = item.path;
    img.alt = '';
    slot.classList.add('loading');
    img.addEventListener('load', () => {
      if (!slot.isConnected) return;
      slot.classList.remove('loading', 'failed');
      layoutThumbs(v);
      cropBox(tile);
      updateReadout(v);
      const opacity = wrap.classList.contains('on') || v.owner.data.arrow || v.owner.data.folded ? 1 : .8;
      animate(wrap, [
        { opacity: 0, transform: 'translateX(-14px) scale(.92)' },
        { opacity, transform: 'translateX(0) scale(1)' },
      ], 350, delay);
      animate(tile.ring, [
        { opacity: 0, inset: '-3px', borderRadius: '8px' },
        { opacity: .85, inset: '-4px', borderRadius: '9px', offset: .15 },
        { opacity: 0, inset: '-9px', borderRadius: '14px' },
      ], 800, delay + 100);
    });
    img.addEventListener('error', () => {
      slot.classList.remove('loading');
      slot.classList.add('failed');
      wrap.title = `Could not load ${item.path}`;
      // Once per path: every redraw of a missing picture used to log again.
      if (!thumbErrors.has(item.path)) { thumbErrors.add(item.path); r7.log('warn', 'steps.thumb_error', { session: cfg.session, path: item.path }); }
    });
    const version = r7.fileVersion ? r7.fileVersion(item.path) : Promise.resolve(0);
    version.catch(() => 0).then((n) => {
      // A picture that failed and is still missing isn't asked for again on every redraw.
      if (!n && thumbErrors.has(item.path)) {
        slot.classList.remove('loading');
        slot.classList.add('failed');
        wrap.title = `Could not load ${item.path}`;
        return;
      }
      img.src = fileUrl(item.path) + (n ? `?v=${n}` : '');
    });
    return tile;
  }

  function sizeText(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1000000) return `${Math.round(bytes / 1000)} KB`;
    return `${(bytes / 1000000).toFixed(1)} MB`;
  }

  function updateReadout(v) {
    const tile = v.tiles.findLast((t) => t.item.active) || v.tiles.at(-1);
    if (!tile) return;
    const item = tile.item;
    const readout = v.owner.data.readout;
    const name = readout?.name || item.name || item.path.replace(/\\/g, '/').split('/').pop();
    const width = item.width || tile.img.naturalWidth;
    const height = item.height || tile.img.naturalHeight;
    const dims = width && height ? `${width}×${height}` : '';
    let crop = Array.isArray(item.crop) && item.crop.length === 4 ? item.crop : null;
    if (crop?.every((n) => n >= 0 && n <= 1) && width && height) crop = crop.map((n, i) => Math.round(n * (i % 2 ? height : width)));
    const summary = readout?.detail || item.label || '';
    const size = sizeText(item.bytes);
    const detail = [
      crop ? `crop ${crop[0]},${crop[1]} · ${crop[2]}×${crop[3]}` : summary.includes(dims) ? '' : dims,
      summary,
      size && !summary.includes(size) ? size : '',
    ].filter((text, i, all) => text && all.indexOf(text) === i).join(' · ');
    const key = `${name}\n${detail}`;
    if (v.readKey === key) return;
    const old = v.readout.firstElementChild;
    const next = el('div', 'sm-readout-text');
    el('div', 'sm-readout-name', next).textContent = name;
    el('div', 'sm-readout-detail', next).textContent = detail;
    v.readout.replaceChildren(next);
    if (old) {
      v.readout.append(old);
      animate(old, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-100%)' }], 180);
      old.style.opacity = '0';
      animate(next, [{ opacity: 0, transform: 'translateY(100%)' }, { opacity: 1, transform: 'translateY(0)' }], 180);
    }
    v.readKey = key;
  }

  function layoutThumbs(v) {
    const mark = v.owner;
    const scale = rowHeight() / 22;
    const folded = !!mark.data.folded;
    const pair = !!mark.data.arrow;
    const H = mark.rows * rowHeight();
    const full = Math.max(8, H - (pair ? 20 : 24) * scale);
    const anyActive = v.tiles.some((t) => t.item.active);
    v.body.style.setProperty('--sm-scale', scale);
    v.body.style.setProperty('--sm-row', `${rowHeight()}px`);
    v.body.style.fontFamily = term.options.fontFamily;
    v.body.classList.toggle('folded', folded);
    v.body.classList.toggle('pair', pair);
    const targets = v.tiles.map((tile) => {
      const active = !!tile.item.active || (!anyActive && v.tiles.length === 1);
      const h = Math.min(full, (pair ? folded ? 44 : 108 : folded ? 40 : active ? 148 : 104) * scale);
      const w = tile.item.width || tile.img.naturalWidth;
      const ht = tile.item.height || tile.img.naturalHeight;
      return { active, h, aspect: w && ht ? w / ht : 16 / 9 };
    });
    const indent = (pair ? folded ? 30 : 52 : 21) * scale;
    const gap = (pair ? 12 : 14) * scale;
    const available = Math.max(20, mark.el.clientWidth - indent - 10 * scale);
    const readWidth = folded || available < 400 * scale ? 0 : Math.min(260 * scale, available * .32);
    v.readout.hidden = available < 400 * scale;
    v.readout.style.width = `${readWidth}px`;
    const gaps = Math.max(0, targets.length - 1) * (gap + (pair ? 16 * scale + gap : 0));
    const desired = targets.reduce((sum, t) => sum + t.h * t.aspect, 0);
    const fit = Math.min(1, Math.max(8, available - readWidth - (readWidth ? 14 * scale : 0) - gaps) / Math.max(1, desired));
    v.tiles.forEach((tile, i) => {
      const t = targets[i];
      tile.slot.style.height = `${t.h * fit}px`;
      tile.slot.style.width = `${t.h * fit * t.aspect}px`;
      tile.wrap.classList.toggle('on', t.active && !folded);
      tile.index.textContent = String(i + 1);
      tile.index.hidden = pair;
      tile.label.textContent = pair ? i === 0 ? 'before' : 'after' : tile.item.label || '';
      tile.label.hidden = !tile.label.textContent;
      cropBox(tile);
    });
  }

  function drawThumbs(mark) {
    const d = mark.data;
    const items = Array.isArray(d.items) ? d.items.filter((i) => i && typeof i.path === 'string' && i.path) : [];
    let v = mark.view;
    if (!v) {
      const body = el('div', 'sm-film');
      const strip = el('div', 'sm-strip', body);
      const readout = el('div', 'sm-readout', body);
      mark.el.replaceChildren(body);
      v = mark.view = { body, strip, readout, tiles: [], owner: mark };
    }
    v.owner = mark;
    const remaining = new Map(v.tiles.map((t) => [t.key, t]));
    const tiles = [];
    const arrivals = [];
    let added = 0, child = v.strip.firstChild;
    items.forEach((item, i) => {
      const key = `${item.path}\n${i}`;
      let tile = remaining.get(key);
      const fresh = !tile;
      if (!tile) {
        tile = makeThumb(v, item, added++ * 100);
        arrivals.push(tile);
      }
      tile.key = key;
      tile.item = item;
      remaining.delete(key);
      if (i > 0 && d.arrow) {
        if (!tile.arrow) {
          tile.arrow = el('span', 'sm-arrow');
          tile.arrow.textContent = '→';
        }
        if (tile.arrow !== child) v.strip.insertBefore(tile.arrow, child);
        child = tile.arrow.nextSibling;
        if (fresh) animate(tile.arrow, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'translateX(0)' }], 350);
      } else {
        if (tile.arrow && child === tile.arrow) child = tile.arrow.nextSibling;
        tile.arrow?.remove();
        tile.arrow = null;
      }
      if (tile.slot !== child) v.strip.insertBefore(tile.slot, child);
      child = tile.slot.nextSibling;
      tiles.push(tile);
    });
    for (const tile of remaining.values()) { tile.slot.remove(); tile.arrow?.remove(); }
    v.tiles = tiles;
    layoutThumbs(v);
    for (const tile of arrivals) animate(tile.slot, [{ width: '0px', opacity: 0 }, { width: tile.slot.style.width, opacity: 1 }], 350, tile.delay);
    updateReadout(v);
  }

  // ---- map -------------------------------------------------------------------------
  function drawMap(mark) {
    const d = mark.data;
    const total = Math.max(1, Number(d.total) || 1);
    const wide = mark.rows > 1;
    const scale = rowHeight() / 22;
    let v = mark.view;
    const freshMap = !v;
    if (!v) {
      mark.el.replaceChildren();
      v = mark.view = {
        label: el('div', 'sm-map-label', mark.el), bars: el('div', 'sm-map-bars', mark.el),
        lens: el('div', 'sm-map-lens', mark.el), ticks: el('div', 'sm-ticks', mark.el), nodes: [],
      };
      el('span', '', v.ticks).textContent = '1';
      el('span', '', v.ticks);
    }
    mark.el.classList.toggle('wide', wide);
    mark.el.style.setProperty('--sm-row', `${rowHeight()}px`);
    mark.el.style.fontFamily = term.options.fontFamily;
    mark.el.style.setProperty('--sm-scale', scale);
    const from = clamp(Number(d.from) || 1, 1, total);
    const to = clamp(Number(d.to) || from, from, total);
    const lo = (from - 1) / total, hi = to / total;
    const count = wide ? 252 : 84;
    if (v.nodes.length !== count) {
      v.bars.replaceChildren();
      v.nodes = Array.from({ length: count }, (_, i) => {
        const node = el('i', '', v.bars);
        node.style.height = `${(6 + ((i * 37 + (i * i % 11) * 13) % 11)) / 22 * 100}%`;
        return node;
      });
    }
    const key = `${count}|${from}|${to}|${total}`;
    if (key !== v.key) {
      v.nodes.forEach((node, i) => {
        const lit = i / count < hi && (i + 1) / count > lo;
        const fresh = lit && !node.classList.contains('on');
        node.classList.toggle('on', lit);
        if (fresh && wide) animate(node, [{ opacity: .2 }, { opacity: 1 }], 300, clamp((i / count - lo) / Math.max(1 / count, hi - lo)) * 1000);
      });
      v.label.textContent = `lines ${number(from)}–${number(to)} · read ${number(to - from + 1)} of ${number(total)} lines`;
      v.ticks.lastElementChild.textContent = number(total);
      v.key = key;
    }
    v.lens.style.left = `${lo * 100}%`;
    v.lens.style.width = `${Math.max(.5, (hi - lo) * 100)}%`;
    if (freshMap && wide) animate(v.lens, [{ opacity: 0 }, { opacity: 1 }], 300);
    v.label.style.right = `${(1 - hi) * 100}%`;
    v.label.style.maxWidth = '100%';
    // Keep the complete label inside the map when the read range is near the start.
    if (v.label.scrollWidth > mark.el.clientWidth * hi) v.label.style.right = 'auto';
  }

  // ---- placement -------------------------------------------------------------------
  // Same rule as marks.js placeMark: shown while any of its rows is on screen, positioned
  // from the row's buffer line in the render that shows it.
  let contentBox = null;
  term.onResize(() => { contentBox = null; });

  function place(mark) {
    const buf = term.buffer.active;
    const t = mark.marker.line - buf.viewportY;
    if (document.hidden || buf.type !== 'normal' || t + mark.rows <= 0 || t >= term.rows) {
      if (mark.el && mark.el.style.display !== 'none') {
        settleMotion(mark);
        mark.el.style.display = 'none';
      }
      return;
    }
    const rowPx = rowHeight();
    const cell = cw();
    // Align marks with the input box's text column.
    const box = findBox();
    if (box) contentBox = box;
    const contentLeft = contentBox ? contentBox.left + 3 : 0;
    const x0 = Math.max(mark.x, contentLeft);
    const x1 = contentBox ? Math.min(term.cols, contentBox.right - 2) : term.cols;
    let cols = x1 - x0;
    let left = x0 * cell;
    if (mark.kind === 'map' && mark.rows === 1) {
      const used = (rowText(mark.marker.line) ?? '').trimEnd().length;
      cols = Math.min(MAP_COLS, x1 - used - 1);
      left = (x1 - cols) * cell;
      if (cols < 6) {
        if (mark.el) { settleMotion(mark); mark.el.style.display = 'none'; }
        return;
      }
    } else if (mark.kind === 'map') {
      left = Math.max(left, contentLeft * cell + 52 * rowPx / 22);
      cols = Math.min(756 * rowPx / 22, x1 * cell - left) / cell;
    }
    if (!mark.el) {
      mark.el = document.createElement('div');
      mark.el.className = `xterm-decoration xterm-decoration-top-layer r7-steps r7-${mark.kind}`;
      if (mark.kind === 'thumbs') mark.el.classList.add('r7-image');
      (screenEl.querySelector('.xterm-decoration-container') || screenEl).append(mark.el);
    }
    const e = mark.el;
    e.style.display = 'block';
    e.style.top = `${t * rowPx}px`;
    e.style.left = `${left}px`;
    e.style.width = `${Math.round(Math.max(1, cols) * cell)}px`;
    e.style.height = `${mark.rows * rowPx}px`;
    if (mark.kind === 'band') drawBand(mark);
    else if (mark.kind === 'thumbs') drawThumbs(mark);
    else drawMap(mark);
  }

  function still(mark) {
    if (mark.marker.isDisposed || mark.marker.line < 0) return false;
    if (mark.kind === 'map' && mark.rows === 1) {
      const text = rowText(mark.marker.line);
      if (text === null) return false;
      return !mark.sig || text.startsWith(mark.sig);
    }
    for (let i = 0; i < mark.rows; i++) if (rowText(mark.marker.line + i)?.trim()) return false;
    return true;
  }

  function placeStepMarks() {
    if (!marks.length) return;
    const buf = term.buffer.active;
    for (const mark of [...marks]) {
      const t = mark.marker.line - buf.viewportY;
      const visible = t + mark.rows > 0 && t < term.rows;
      if (visible && buf.type === 'normal' && !still(mark)) { drop(mark); continue; }
      place(mark);
    }
  }

  // What the map's row says once the program has finished writing it.
  term.onWriteParsed(() => {
    for (const mark of marks) {
      if (mark.kind === 'map' && mark.rows === 1 && !mark.sig) mark.sig = (rowText(mark.marker.line) ?? '').trimEnd();
    }
  });
  term.onRender(() => placeStepMarks());

  // parts: the OSC's fields after the kind, e.g. ['2', '<uri-json>'] for band/thumbs and
  // ['<uri-json>'] for map. Returns true when the mark was taken.
  function handleStepMark(kind, parts) {
    if (kind !== 'band' && kind !== 'thumbs' && kind !== 'map') return false;
    const map = kind === 'map';
    const data = parseJson(parts.slice(map ? 0 : 1).join(';'));
    if (!data) return true;
    const rows = map ? data.rows === 3 ? 3 : 1 : Math.max(1, Math.min(8, parseInt(parts[0], 10) || 0));
    const marker = term.registerMarker(0);
    if (!marker) return true;
    const mark = { kind, x: term.buffer.active.cursorX, rows, data, marker, el: null, view: null, sig: null };
    // A re-sent mark takes over the old element so a band's lens glides and nothing flickers.
    const sameStrip = (m) => kind === 'thumbs' && data.startedAt > 0 && data.startedAt === m.data.startedAt
      && Array.isArray(data.items) && Array.isArray(m.data.items)
      && data.items.some((item) => m.data.items.some((other) => item.path === other.path));
    const previous = marks.filter((m) => m.kind === kind && (m.marker.line === marker.line || sameStrip(m)));
    for (const old of previous) {
      if (old.el && !mark.el) {
        mark.el = old.el;
        mark.view = old.view;
        if (kind === 'thumbs' && mark.view) mark.view.owner = mark;
        old.el = null;
      }
      drop(old);
    }
    marker.onDispose(() => { const i = marks.indexOf(mark); if (i >= 0) { mark.el?.remove(); marks.splice(i, 1); } });
    marks.push(mark);
    return true;
  }

  window.handleStepMark = handleStepMark;
  window.placeStepMarks = placeStepMarks;
})();
