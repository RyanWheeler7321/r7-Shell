'use strict';
// Pinned media: a strip of thumbnails at the top right that grow into a preview on
// hover. `r7shell pin` or r7shell.setPins(entries) sends them; entries are newest
// first. Only the thumbnail strip takes pointer events; the preview never does.

(() => {
  const MAX_MEDIA = 8;
  const THUMB_MIN = 18;
  const THUMB_MAX = 96;
  const GAP = 8;
  const INSET = 8;
  const TOP_INSET = 32;
  const PREVIEW_INSET = 24;
  const RAIL = 20;
  const EXPAND_MS = 150;
  const BLEND_MS = 120;
  const LEAVE_MS = 120;

  const S = {
    sig: '', revision: '', entries: [], index: 0, hovered: null,
    root: null, strip: null, rail: null, preview: null,
    slots: [], tiles: new Map(), dims: new Map(),
    layer: null, target: false, progress: 0, anim: 0, failed: null,
    leaveTimer: 0, resizeFrame: 0, wheelAcc: 0,
  };

  const easeOut = (t) => 1 - (1 - t) ** 3;
  const current = () => S.entries[S.index] || null;
  const viewWidth = () => document.documentElement.clientWidth;
  const viewHeight = () => document.documentElement.clientHeight;

  function fileUrl(path) {
    const p = path.replace(/\\/g, '/');
    if (p.startsWith('//')) return 'file://' + p.slice(2).split('/').map(encodeURIComponent).join('/');
    const parts = p.split('/');
    return 'file:///' + [parts[0], ...parts.slice(1).map(encodeURIComponent)].join('/');
  }

  // Windows, \\wsl.localhost or WSL paths; the kind comes from the extension when not given.
  const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v)$/i;
  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
  function toMedia(m) {
    if (!m || typeof m.path !== 'string') return null;
    const path = m.path.startsWith('/') ? windowsPath(m.path) : m.path;
    if (!/^([A-Za-z]:\\|\\\\)/.test(path)) return null;
    const kind = m.kind || (VIDEO_RE.test(path) ? 'video' : IMAGE_RE.test(path) ? 'image' : '');
    if (kind !== 'image' && kind !== 'video') return null;
    return { kind, name: String(m.name || path.split('\\').pop()), path };
  }

  function normalize(value) {
    if (!Array.isArray(value)) return [];
    const entries = [];
    for (const raw of value) {
      if (!raw || typeof raw !== 'object' || !raw.id || !Array.isArray(raw.media)) continue;
      // The entry id goes on each file URL, so a file pinned again after it was rewritten
      // shows its new contents instead of Chromium's cached copy.
      const media = raw.media.map(toMedia).filter(Boolean).slice(0, MAX_MEDIA)
        .map((m) => ({ ...m, version: encodeURIComponent(String(raw.id)) }));
      if (media.length) entries.push({ id: String(raw.id), media });
    }
    return entries;
  }

  // Wheel-up goes older, wheel-down newer, without wrapping.
  function cycleEntryIndex(index, wheelDelta, count) {
    if (count <= 0) return 0;
    if (!wheelDelta) return Math.max(0, Math.min(index, count - 1));
    return Math.max(0, Math.min(index + (wheelDelta > 0 ? 1 : -1), count - 1));
  }

  // Left-to-right slots; media index 0 sits at the right edge.
  function thumbnailLayout(count, width) {
    count = Math.max(0, Math.min(MAX_MEDIA, count));
    const usable = Math.max(0, width - 2 * INSET - RAIL);
    if (!count) return [];
    const forTiles = usable - GAP * (count - 1);
    if (forTiles < THUMB_MIN * count) return [];
    const size = Math.min(THUMB_MAX, Math.floor(forTiles / count));
    const slots = [];
    for (let i = 0; i < count; i++) slots.push({ media: count - 1 - i, x: i * (size + GAP), size });
    return slots;
  }

  // Center a source inside bounds without changing its aspect or upscaling it.
  function containedRect(sw, sh, left, top, width, height) {
    if (sw <= 0 || sh <= 0 || width <= 0 || height <= 0) return { left, top, width: 0, height: 0 };
    const scale = Math.min(1, width / sw, height / sh);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    return { left: left + Math.floor((width - w) / 2), top: top + Math.floor((height - h) / 2), width: w, height: h };
  }

  // ---- DOM ---------------------------------------------------------------------

  function mount() {
    if (S.root) return;
    const root = document.createElement('div');
    root.id = 'r7-pins';
    const preview = document.createElement('div');
    preview.className = 'r7-pins-preview';
    const strip = document.createElement('div');
    strip.className = 'r7-pins-strip';
    const rail = document.createElement('div');
    rail.className = 'r7-pins-rail';
    strip.append(rail);
    // Strip below the preview so the (input-transparent) preview paints over it.
    root.append(strip, preview);
    const term = document.getElementById('term');
    if (term) term.after(root); else document.body.append(root);
    Object.assign(S, { root, strip, rail, preview });

    strip.addEventListener('pointerenter', onPointer);
    strip.addEventListener('pointermove', onPointer);
    strip.addEventListener('pointerleave', onLeave);
    strip.addEventListener('wheel', onWheel, { passive: false });
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
      strip.addEventListener(type, swallow);
    }
    window.addEventListener('resize', onResize);
  }

  function unmount() {
    if (!S.root) return;
    clearPreview();
    clearTimeout(S.leaveTimer);
    cancelAnimationFrame(S.resizeFrame);
    window.removeEventListener('resize', onResize);
    S.root.remove();
    Object.assign(S, { root: null, strip: null, rail: null, preview: null, slots: [], hovered: null });
    S.tiles.clear();
  }

  function swallow(e) {
    e.stopPropagation();
    // Keeps focus in the terminal instead of moving it to the strip.
    e.preventDefault();
  }

  function makeMedia(media, still) {
    const url = fileUrl(media.path) + (media.version ? `?v=${media.version}` : '');
    if (media.kind === 'image') {
      const img = document.createElement('img');
      img.decoding = 'async';
      img.alt = media.name;
      img.addEventListener('load', () => S.dims.set(media.path, { w: img.naturalWidth, h: img.naturalHeight }));
      img.src = url;
      return img;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('loadedmetadata', () => S.dims.set(media.path, { w: video.videoWidth, h: video.videoHeight }));
    if (still) {
      // A tiny start offset makes Chromium paint the first frame as the poster.
      video.preload = 'auto';
      video.src = url + '#t=0.001';
    } else {
      video.loop = true;
      video.autoplay = true;
      video.src = url;
      video.play().catch(() => {});
    }
    return video;
  }

  function renderStrip() {
    const entry = current();
    if (!S.root || !entry) return;
    const capacity = Math.max(...S.entries.map((e) => e.media.length));
    S.slots = thumbnailLayout(capacity, viewWidth());
    if (!S.slots.length) {
      // Too narrow: nothing shows and nothing catches events.
      endHover(true);
      S.strip.hidden = true;
      return;
    }
    S.strip.hidden = false;
    const size = S.slots[0].size;
    S.strip.style.width = `${S.slots[S.slots.length - 1].x + size + RAIL}px`;
    S.strip.style.height = `${size}px`;

    for (const [index, tile] of S.tiles) {
      if (index >= entry.media.length) { tile.el.remove(); S.tiles.delete(index); }
    }
    for (const slot of S.slots) {
      if (slot.media >= entry.media.length) continue;
      const media = entry.media[slot.media];
      let tile = S.tiles.get(slot.media);
      if (!tile || tile.path !== media.path) {
        if (tile) tile.el.remove();
        const el = document.createElement('div');
        el.className = 'r7-pins-tile' + (media.kind === 'video' ? ' video' : '');
        el.append(makeMedia(media, true));
        S.strip.append(el);
        tile = { el, path: media.path };
        S.tiles.set(slot.media, tile);
      }
      Object.assign(tile.el.style, { left: `${slot.x}px`, width: `${size}px`, height: `${size}px` });
      tile.el.style.setProperty('--side', `${Math.max(5, Math.floor(size / 4))}px`);
    }
    markTiles();
    renderRail(size);
  }

  // Newest at the bottom, current larger, distant dots fading; a bounded window of 7.
  function renderRail(height) {
    const count = S.entries.length;
    let first = Math.max(0, S.index - 3);
    const last = Math.min(count, first + 7);
    first = Math.max(0, last - 7);
    const spacing = Math.min(12, Math.max(6, Math.floor((height - 12) / Math.max(1, last - first))));
    const dots = [];
    for (let i = first; i < last; i++) {
      const isCurrent = i === S.index;
      const r = isCurrent ? 3.5 : 2;
      const alpha = isCurrent ? 1 : Math.max(35, 150 - 28 * Math.abs(i - S.index)) / 255;
      const dot = document.createElement('div');
      dot.className = 'r7-pins-dot';
      Object.assign(dot.style, {
        width: `${2 * r}px`, height: `${2 * r}px`, left: `${RAIL / 2 - r}px`,
        top: `${height - 8 - (i - first) * spacing - r}px`, opacity: String(alpha),
      });
      dots.push(dot);
    }
    S.rail.replaceChildren(...dots);
  }

  function markTiles() {
    const covered = S.layer ? S.layer.index : null;
    for (const [index, tile] of S.tiles) {
      tile.el.classList.toggle('hovered', index === S.hovered);
      tile.el.classList.toggle('covered', index === covered);
    }
  }

  // ---- preview -----------------------------------------------------------------

  // Grow the thumbnail's contained image rect toward one shared top/right anchor.
  function layerRect(layer, progress) {
    const dims = S.dims.get(layer.media.path);
    if (!dims || !dims.w || !dims.h) return null;
    const o = layer.origin;
    const start = containedRect(dims.w, dims.h, o.left, o.top, o.width, o.height);
    const anchor = viewWidth() - INSET - RAIL;
    const right = Math.min(viewWidth() - PREVIEW_INSET, anchor);
    const top = start.top;
    const pad = PREVIEW_INSET + 24;
    const availW = Math.max(1, right - pad);
    const availH = Math.max(1, viewHeight() - pad - top);
    const scale = Math.min(1, availW / dims.w, availH / dims.h);
    const endW = Math.max(1, Math.round(dims.w * scale));
    const endH = Math.max(1, Math.round(dims.h * scale));
    const w = Math.max(1, Math.round(start.width + (endW - start.width) * progress));
    const h = Math.max(1, Math.round(start.height + (endH - start.height) * progress));
    const r = Math.round(start.left + start.width + (right - start.left - start.width) * progress);
    return { left: r - w, top: start.top, width: w, height: h };
  }

  function place() {
    const layer = S.layer;
    if (!layer) return;
    const rect = layerRect(layer, S.progress);
    layer.el.classList.toggle('unsized', !rect);
    if (!rect) return;
    Object.assign(layer.el.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
  }

  function animate(to, done) {
    cancelAnimationFrame(S.anim);
    const from = S.progress;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / EXPAND_MS);
      S.progress = from + (to - from) * easeOut(t);
      place();
      if (t < 1) S.anim = requestAnimationFrame(step);
      else { S.anim = 0; if (done) done(); }
    };
    S.anim = requestAnimationFrame(step);
  }

  function tileOrigin(index) {
    const tile = S.tiles.get(index);
    if (!tile) return null;
    const r = tile.el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function dropLayer(layer) {
    const media = layer.el.firstChild;
    if (media && media.tagName === 'VIDEO') { media.pause(); media.removeAttribute('src'); media.load(); }
    layer.el.remove();
  }

  function showMedia(index) {
    const entry = current();
    if (!entry || index < 0 || index >= entry.media.length) return;
    if (S.hovered === index && (S.target || S.failed === index)) return;
    const origin = tileOrigin(index);
    if (!origin) return;
    const media = entry.media[index];
    setHovering(true);
    S.hovered = index;
    S.failed = null;

    const el = document.createElement('div');
    el.className = 'r7-pins-layer';
    const mediaEl = makeMedia(media, false);
    const sized = () => { if (S.layer && S.layer.el === el) place(); };
    mediaEl.addEventListener(media.kind === 'image' ? 'load' : 'loadedmetadata', sized);
    mediaEl.addEventListener('error', () => {
      if (S.layer && S.layer.el === el) { S.failed = index; collapse(); }
    });
    el.append(mediaEl);
    const layer = { el, media, index, origin };

    const old = S.layer;
    const blend = old && S.progress > 0;
    if (old) {
      if (blend) {
        // Freeze the old picture where it is and fade it out under the new one.
        old.el.classList.add('fading');
        const oldMedia = old.el.firstChild;
        if (oldMedia && oldMedia.tagName === 'VIDEO') oldMedia.pause();
        setTimeout(() => dropLayer(old), BLEND_MS + 20);
      } else {
        dropLayer(old);
      }
    }
    S.layer = layer;
    markTiles();
    if (blend) {
      cancelAnimationFrame(S.anim);
      S.anim = 0;
      S.progress = 1;
      S.target = true;
      el.classList.add('pending');
      S.preview.append(el);
      place();
      requestAnimationFrame(() => el.classList.remove('pending'));
      return;
    }
    S.preview.append(el);
    S.progress = 0;
    place();
    expand();
  }

  function expand() {
    S.target = true;
    if (S.progress >= 1) { place(); return; }
    animate(1);
  }

  function collapse() {
    S.target = false;
    for (const el of [...S.preview.children]) {
      if (!S.layer || el !== S.layer.el) el.remove();
    }
    const layer = S.layer;
    if (!layer) return;
    const mediaEl = layer.el.firstChild;
    if (mediaEl && mediaEl.tagName === 'VIDEO') mediaEl.pause();
    animate(0, () => {
      if (S.layer !== layer) return;
      dropLayer(layer);
      S.layer = null;
      markTiles();
    });
  }

  function clearPreview() {
    cancelAnimationFrame(S.anim);
    S.anim = 0;
    if (S.layer) dropLayer(S.layer);
    if (S.preview) for (const el of [...S.preview.children]) dropLayer({ el });
    Object.assign(S, { layer: null, target: false, progress: 0, hovered: null, failed: null });
  }

  // ---- input -------------------------------------------------------------------

  function setHovering(on) {
    if (S.strip) S.strip.classList.toggle('hovering', on);
  }

  function tileAt(e) {
    const entry = current();
    if (!entry) return null;
    const x = e.clientX - S.strip.getBoundingClientRect().left;
    const slot = S.slots.find((s) => x >= s.x && x < s.x + s.size);
    return slot && slot.media < entry.media.length ? slot.media : null;
  }

  function onPointer(e) {
    e.stopPropagation();
    clearTimeout(S.leaveTimer);
    S.leaveTimer = 0;
    setHovering(true);
    const index = tileAt(e);
    if (index !== null) showMedia(index);
  }

  function onLeave(e) {
    e.stopPropagation();
    clearTimeout(S.leaveTimer);
    // Close only if the pointer really left (not a transient leave).
    S.leaveTimer = setTimeout(() => {
      S.leaveTimer = 0;
      if (S.strip && !S.strip.matches(':hover')) endHover(false);
    }, LEAVE_MS);
  }

  function endHover(immediate) {
    clearTimeout(S.leaveTimer);
    S.leaveTimer = 0;
    setHovering(false);
    S.hovered = null;
    if (immediate) clearPreview(); else collapse();
    markTiles();
  }

  function onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    // Line/page deltas step at once; trackpad pixels accumulate to one step.
    S.wheelAcc += e.deltaMode ? Math.sign(e.deltaY) * 100 : e.deltaY;
    if (Math.abs(S.wheelAcc) < 50) return;
    const delta = S.wheelAcc < 0 ? 1 : -1; // wheel-up is older
    S.wheelAcc = 0;
    const next = cycleEntryIndex(S.index, delta, S.entries.length);
    if (next === S.index) return;
    const selected = S.hovered;
    S.index = next;
    S.hovered = null;
    renderStrip();
    if (selected !== null && current()) showMedia(Math.min(selected, current().media.length - 1));
  }

  function onResize() {
    cancelAnimationFrame(S.resizeFrame);
    S.resizeFrame = requestAnimationFrame(() => {
      renderStrip();
      if (S.layer) {
        const origin = tileOrigin(S.layer.index);
        if (origin) { S.layer.origin = origin; place(); }
      }
    });
  }

  // ---- API ---------------------------------------------------------------------

  function update(value, revision) {
    // A revision that hasn't changed means the same entries.
    if (revision && revision === S.revision) return;
    S.revision = revision || '';
    let sig;
    try { sig = JSON.stringify(value || []); } catch { sig = String(Math.random()); }
    if (sig === S.sig) return;
    S.sig = sig;
    const entries = normalize(value);
    if (!entries.length) {
      S.entries = [];
      S.index = 0;
      unmount();
      return;
    }
    const oldIds = new Set(S.entries.map((e) => e.id));
    const previousId = current() ? current().id : '';
    const added = !oldIds.has(entries[0].id);
    const kept = entries.findIndex((e) => e.id === previousId);
    S.index = added ? 0 : kept >= 0 ? kept : Math.min(S.index, entries.length - 1);
    S.entries = entries;
    mount();
    clearPreview();
    renderStrip();
    // Not for the pins already there when the window opens.
    if (added && performance.now() > 2500) arrive(entries[0]);
  }

  // A new entry pops into the strip with a small bounce. When its picture is showing in a
  // reply, a copy of it flies from there into the strip first.
  function arrive(entry) {
    const strip = S.strip;
    if (!strip || strip.hidden || document.hidden) return;
    // The class comes off when it ends, or showing the strip again (a resize) replays it.
    const pop = () => {
      strip.classList.remove('arrive');
      void strip.offsetWidth;
      strip.classList.add('arrive');
      strip.addEventListener('animationend', () => strip.classList.remove('arrive'), { once: true });
    };
    // Pins carry Windows paths, reply pictures may carry WSL ones.
    const same = (p) => String(p).replace(/\\/g, '/').replace(/^\/mnt\/([a-z])\//i, '$1:/').toLowerCase();
    const paths = new Set(entry.media.map((m) => same(m.path)));
    const from = [...document.querySelectorAll('.r7-image img')].find((img) => paths.has(same(img.dataset.path)) && img.offsetParent && img.width);
    const tile = S.tiles.get(0)?.el;
    if (!from || !tile) { pop(); return; }
    const a = from.getBoundingClientRect();
    const b = tile.getBoundingClientRect();
    if (a.bottom < 0 || a.top > window.innerHeight) { pop(); return; }
    const fly = from.cloneNode();
    fly.className = 'r7-pins-fly';
    Object.assign(fly.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
    document.body.append(fly);
    void fly.offsetWidth; // styled where it starts, so the move animates
    strip.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      fly.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width}, ${b.height / a.height})`;
      fly.style.opacity = '0.4';
    });
    setTimeout(() => { fly.remove(); strip.style.visibility = ''; pop(); }, 240);
  }

  pinListeners.push(update);
})();
