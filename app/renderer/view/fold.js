'use strict';

// Fold finished step stretches into counts, thumbnails and elapsed time.
(() => {
  const view = window.r7View;
  const cards = window.r7Cards;
  const column = document.getElementById('view-column');
  if (!view || !column) return;

  // Thoughts separate stretches of steps and stay visible when those steps fold.
  const WORK = new Set(['step', 'group', 'done']);
  const MAX_THUMBS = 8;
  // Leave steps visible briefly before folding.
  // Steps with pictures get longer, counted from when their pictures arrived; then they fold too.
  const MIN_SHOWN_MS = 1500, MIN_PICTURE_MS = 3000;
  // A fold closes over FOLD_MS while its pictures fly into the summary line's thumbnails.
  const FOLD_MS = 340, EASE = 'cubic-bezier(.4,0,.2,1)';
  const VERB = { read: 'read', search: 'searched', edit: 'edited', test: 'tested', build: 'built', check: 'checked', web: 'web', image: 'images', app: 'app', wait: 'waited', risk: 'risky', other: 'ran' };
  const ICON = { read: '≡', search: '⌕', edit: '✎', test: '▶', build: '⬡', check: '◇', web: '◈', image: '◉', app: '◆', wait: '◷', risk: '▲', other: '•', helpers: '✦' };
  const ORDER = ['edit', 'read', 'search', 'test', 'build', 'check', 'web', 'image', 'app', 'risk', 'wait', 'other'];

  // Index stretches by their first block and remember which ones the user opened.
  const stretches = new Map(), owner = new Map(), opened = new Set();
  // When each block first showed live; backlog (replay, attach) counts as long seen.
  const seenAt = new Map();
  // When a block's pictures first showed: a slow image step's dwell starts with its picture.
  const pictureAt = new Map();
  let recheckTimer = 0, recheckAt = 0, animateNow = false;
  let lastError = '';

  function log(name, fields = {}) {
    r7.log('info', name, { session: cfg.session, ...fields });
  }
  // One line per distinct failure, so a broken pass cannot flood the log.
  function fail(err) {
    const message = String(err?.stack || err);
    if (message === lastError) return;
    lastError = message;
    r7.log('error', 'fold.error', { session: cfg.session, error: message });
  }

  function kindOf(row) {
    const label = String(row.done || row.active || '');
    if (/^Wait/.test(label)) return 'wait';
    if (/^Test/.test(label)) return 'test';
    if (/^(?:Build|Built)/.test(label)) return 'build';
    if (row.risk || row.kind === 'risky') return 'risk';
    return VERB[row.kind] ? row.kind : 'other';
  }

  function clock(s) {
    if (s < 60) return `${Math.max(1, Math.round(s))}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
  }

  // Counts by kind and the pictures looked at, from the blocks that are folded.
  function tally(tops) {
    const kinds = {}, found = new Map();
    let steps = 0, helpers = 0;
    const add = (kind, n = 1) => { kinds[kind] = (kinds[kind] || 0) + n; steps += n; };
    const step = (b) => {
      const row = b.ev.step;
      add(row ? kindOf(row) : 'other');
      for (const item of row?.thumbs || []) {
        if (!item?.path) continue;
        found.delete(item.path);
        found.set(item.path, item);
      }
    };
    for (const { b, kids } of tops) {
      if (b.kind === 'done') helpers++;
      else if (b.kind === 'step') step(b);
      else if (b.kind === 'group') {
        if (kids) for (const kid of kids) step(kid);
        else add(VERB[b.ev.group] ? b.ev.group : 'other', b.ev.members?.length || 1);
      }
    }
    return { kinds, steps, helpers, images: [...found.values()].reverse() };
  }

  // Symbols, the same ones the step rows use; the words are in the line's tooltip.
  function mainHtml({ kinds, steps, helpers }) {
    const parts = ORDER.filter((k) => kinds[k]).map((k) => `<span class="f-kind f-${k}"><i>${ICON[k]}</i>${kinds[k]}</span>`);
    if (helpers) parts.push(`<span class="f-kind f-helpers"><i>${ICON.helpers}</i>${helpers}</span>`);
    const lead = steps ? `<span class="f-count">${steps} step${steps === 1 ? '' : 's'}</span>` : '';
    return lead + parts.join('');
  }
  function mainWords({ kinds, steps, helpers }) {
    const parts = ORDER.filter((k) => kinds[k]).map((k) => `${VERB[k]} ${kinds[k]}`);
    if (helpers) parts.push(`helpers ${helpers}`);
    return `${steps} step${steps === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
  }

  // Keeps `el` where it is on screen while `fn` changes the page around it.
  function keepPlace(el, fn) {
    if (!el || view.jumping) { fn(); return; }
    const top = el.getBoundingClientRect().top;
    fn();
    const after = el.getBoundingClientRect();
    // An anchor that folded away has nothing to hold.
    if (!after.height) return;
    const dy = after.top - top;
    // keys.css makes the page scroll smoothly; this correction must jump.
    if (Math.abs(dy) > 0.5) view.root.scrollTo({ top: view.root.scrollTop + dy, behavior: 'instant' });
    view.rememberPlace();
  }
  // The first thing on screen that does not fold away, to hold the reader's place by.
  function anchor() {
    const top = view.root.getBoundingClientRect().top;
    for (const el of column.children) {
      if (el.classList.contains('view-spacer')) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.height || rect.bottom <= top) continue;
      if (el.classList.contains('f-head') || !WORK.has(el.dataset.viewKind)) return el;
    }
    return null;
  }

  // ---- thumbnails ----
  // The newest two pictures that loaded (or are loading) always keep their room; older ones give way to the summary text.
  function keepRoom(box) {
    const kept = [...box.querySelectorAll('.f-thumb:not(.f-failed)')].slice(0, 2);
    const aspect = kept.reduce((sum, el) => sum + (Number(el.style.getPropertyValue('--f-aspect')) || 16 / 9), 0);
    box.style.minWidth = kept.length ? `calc(var(--f-thumb-h) * ${aspect.toFixed(3)} + ${(kept.length - 1) * 4}px)` : '';
  }
  function thumb(item) {
    const el = document.createElement('span');
    el.className = 'f-thumb';
    el.title = item.name || String(item.path).split(/[\\/]/).pop();
    const aspect = (w, h) => Math.min(2.2, Math.max(0.8, w / h));
    el.style.setProperty('--f-aspect', String(item.width > 0 && item.height > 0 ? aspect(item.width, item.height) : 16 / 9));
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('load', () => {
      if (!(item.width > 0 && item.height > 0)) {
        el.style.setProperty('--f-aspect', String(aspect(img.naturalWidth, img.naturalHeight || 1)));
        if (el.parentElement) keepRoom(el.parentElement);
      }
      el.classList.add('f-loaded');
      cards?.crisp(img);
    });
    img.addEventListener('error', () => {
      el.classList.add('f-failed');
      if (el.parentElement) keepRoom(el.parentElement);
    });
    el.append(img);
    // A summary line is always on screen when it's built, so its few small thumbnails load directly.
    // The file's version keeps a path that was written again from showing the browser's cached copy.
    let url;
    try { url = cards.fileUrl(item.path); }
    catch { el.classList.add('f-failed'); return el; }
    const version = r7.fileVersion ? r7.fileVersion(item.path) : Promise.resolve(0);
    version.catch(() => 0).then((n) => { img.src = url + (n ? `?v=${n}` : ''); });
    return el;
  }
  // Newest first. Pictures already drawn are moved, never rebuilt.
  function showThumbs(s, images) {
    if (!cards) return;
    const shown = images.slice(0, MAX_THUMBS), more = images.length - shown.length;
    const sig = `${shown.map((i) => i.path).join('|')}#${more}`;
    if (sig === s.thumbSig) return;
    s.thumbSig = sig;
    const next = new Map(), nodes = [];
    for (const item of shown) {
      const el = s.thumbs.get(item.path) || thumb(item);
      next.set(item.path, el);
      nodes.push(el);
    }
    s.thumbs = next;
    if (more > 0) {
      const tag = document.createElement('span');
      tag.className = 'f-more';
      tag.textContent = `+${more}`;
      tag.title = `${more} older picture${more === 1 ? '' : 's'}`;
      nodes.push(tag);
    }
    s.thumbBox.replaceChildren(...nodes);
    keepRoom(s.thumbBox);
  }

  // ---- summary line ----
  function makeLine(s) {
    const line = document.createElement('div');
    line.className = 'f-line';
    line.setAttribute('role', 'button');
    line.tabIndex = 0;
    line.innerHTML = '<span class="f-chev"></span><span class="f-main"></span><span class="f-thumbs"></span><span class="f-time"></span>';
    [s.chev, s.main, s.thumbBox, s.timeEl] = line.children;
    line.addEventListener('click', (event) => {
      if (event.ctrlKey || window.getSelection()?.toString()) return;
      toggle(s);
    });
    line.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggle(s);
    });
    return line;
  }
  function paintOpen(s) {
    if (!s.line) return;
    s.line.classList.toggle('f-open', s.open);
    s.line.setAttribute('aria-expanded', String(s.open));
    const mark = s.open ? '▾' : '▸';
    if (s.chev.textContent !== mark) s.chev.textContent = mark;
  }
  function setOpen(s, on) {
    s.open = on;
    if (on) opened.add(s.key); else opened.delete(s.key);
    view.setFold(s.key, { ids: s.foldIds, headId: s.foldHead, open: on });
    for (const el of s.hidden) el.classList.toggle('f-open', on);
    paintOpen(s);
  }
  function toggle(s) {
    // Opening something under the reader must not drag the page to the bottom again.
    if (!s.open) view.release('fold');
    keepPlace(s.line, () => setOpen(s, !s.open));
    log('fold.toggle', { id: s.key, open: s.open });
  }
  function removeLine(s) {
    s.line?.remove();
    s.line = null;
    s.chev = s.main = s.thumbBox = s.timeEl = null;
    s.mainHtml = s.thumbSig = null;
    s.thumbs = new Map();
  }

  // ---- stretches ----
  function same(old, next) {
    if (old.length !== next.length) return false;
    for (let i = 0; i < old.length; i++) {
      const a = old[i], b = next[i];
      if (a.b.el !== b.b.el || a.b.ev !== b.b.ev) return false;
      const n = a.kids?.length || 0;
      if (n !== (b.kids?.length || 0)) return false;
      for (let j = 0; j < n; j++) if (a.kids[j].el !== b.kids[j].el || a.kids[j].ev !== b.kids[j].ev) return false;
    }
    return true;
  }
  function own(s, tops, on) {
    const set = (id) => { if (on) owner.set(id, s); else if (owner.get(id) === s) owner.delete(id); };
    for (const { b, kids } of tops) {
      set(b.id);
      if (kids) for (const kid of kids) set(kid.id);
    }
  }
  function drop(s) {
    view.setFold(s.key, null);
    for (const el of s.hidden) el.classList.remove('f-in', 'f-open', 'f-head');
    own(s, s.tops || [], false);
    removeLine(s);
    s.head = null;
    stretches.delete(s.key);
  }
  function running(tops) {
    return tops.some(({ b }) => b.ev.state === 'running' || b.ev.state === 'pending');
  }
  // Work that has not finished (a group is live while any of its steps is) never folds.
  const isLive = (row) => row?.state === 'running' || row?.state === 'pending';
  function active({ b, kids }) {
    if (isLive(b.ev) || isLive(b.ev.step)) return true;
    return !!kids?.some((kid) => isLive(kid.ev) || isLive(kid.ev.step));
  }

  // ---- timing ----
  function hasPictures({ b, kids }) {
    if (b.ev.step?.thumbs?.length) return true;
    return !!kids?.some((kid) => kid.ev.step?.thumbs?.length);
  }
  // How much longer this top must stay before it may fold (0: it may fold now).
  function remaining(top, now) {
    let at = seenAt.get(top.b.id) ?? -Infinity, pic = pictureAt.get(top.b.id) ?? -Infinity;
    for (const kid of top.kids || []) {
      at = Math.max(at, seenAt.get(kid.id) ?? -Infinity);
      pic = Math.max(pic, pictureAt.get(kid.id) ?? -Infinity);
    }
    return Math.max(0, at + MIN_SHOWN_MS - now, hasPictures(top) ? pic + MIN_PICTURE_MS - now : 0);
  }
  // One timer for the soonest stretch that is waiting to fold.
  function recheck(ms) {
    const at = performance.now() + ms;
    if (recheckTimer && recheckAt <= at) return;
    clearTimeout(recheckTimer);
    recheckAt = at;
    recheckTimer = setTimeout(() => {
      recheckTimer = 0;
      try { run(); } catch (err) { fail(err); }
    }, ms + 20);
  }

  // ---- fold motion ----
  // Before blocks fold: how tall they stand on screen, a copy of them to shrink away, and where
  // their pictures are, so the pictures can fly into the summary line.
  function capture(els) {
    const box = view.root.getBoundingClientRect();
    const shown = els.filter((el) => el.getClientRects().length);
    if (!shown.length) return null;
    const first = shown[0].getBoundingClientRect(), last = shown.at(-1).getBoundingClientRect();
    if (last.bottom <= box.top || first.top >= box.bottom) return null;
    // The column is a flex box (no margin collapsing), so the room they free is their outer heights.
    let span = 0;
    for (const el of shown) {
      const style = getComputedStyle(el);
      span += el.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }
    const pics = [];
    for (const el of shown) {
      for (const img of el.querySelectorAll('.c-picture.c-loaded img[data-path]')) {
        const rect = img.getBoundingClientRect();
        if (rect.width && rect.bottom > box.top && rect.top < box.bottom) pics.push({ path: img.dataset.path, rect, src: img.currentSrc || img.src });
      }
    }
    const flying = new Set(pics.map((p) => p.path));
    const clones = shown.map((el) => {
      const copy = el.cloneNode(true);
      copy.classList.remove('f-in', 'f-open', 'f-head');
      copy.querySelectorAll('.f-line').forEach((x) => x.remove());
      for (const x of [copy, ...copy.querySelectorAll('[data-view-id]')]) x.removeAttribute('data-view-id');
      for (const img of copy.querySelectorAll('img[data-path]')) if (flying.has(img.dataset.path)) img.style.visibility = 'hidden';
      return copy;
    });
    return { span, pics, clones };
  }
  // After the fold: the copy shrinks to nothing under the summary line while the pictures fly
  // into their thumbnails. `lineNew` means the line just took some of the room itself.
  function play(s, m, lineNew) {
    if (!m || !s.line?.isConnected) return;
    const lineRoom = lineNew ? s.line.getBoundingClientRect().height + 6 : 0;
    const height = Math.max(0, m.span - lineRoom);
    // The ghost sits inside a zoomed block, so its CSS height is in unzoomed pixels.
    const zoom = parseFloat(getComputedStyle(column).getPropertyValue('--view-zoom')) || 1;
    const ghost = document.createElement('div');
    ghost.className = 'f-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.height = `${height / zoom}px`;
    const inner = document.createElement('div');
    inner.className = 'f-ghost-inner';
    inner.append(...m.clones);
    ghost.append(inner);
    s.line.after(ghost);
    if (lineNew) s.line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FOLD_MS * 0.8, easing: 'ease-out' });
    const close = ghost.animate([{ height: `${height / zoom}px` }, { height: '0px' }], { duration: FOLD_MS, easing: EASE, fill: 'forwards' });
    inner.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px) scale(.985)' }], { duration: FOLD_MS * 0.75, easing: 'ease-out', fill: 'forwards' });
    const end = () => ghost.remove();
    close.finished.then(end, end);
    // Following keeps the freed space below the transcript (up to a third of the page, view.js
    // VACANCY_SHARE), so its summary stays put.
    const drop = view.following ? 0 : Math.min(height, view.root.scrollTop);
    for (const p of m.pics) {
      const thumb = s.thumbs.get(p.path);
      const to = thumb?.isConnected ? thumb.getBoundingClientRect() : null;
      if (!to?.width) continue;
      const fly = document.createElement('img');
      fly.className = 'f-fly';
      fly.src = p.src;
      fly.alt = '';
      Object.assign(fly.style, { left: `${to.left}px`, top: `${to.top + drop}px`, width: `${to.width}px`, height: `${to.height}px` });
      document.body.append(fly);
      thumb.classList.add('f-landing');
      const from = `translate(${p.rect.left - to.left}px, ${p.rect.top - to.top - drop}px) scale(${p.rect.width / to.width}, ${p.rect.height / to.height})`;
      const flight = fly.animate([{ transform: from }, { transform: 'none' }], { duration: FOLD_MS + 60, easing: 'cubic-bezier(.3,.7,.2,1)' });
      const land = () => { fly.remove(); thumb.classList.remove('f-landing'); };
      flight.finished.then(land, land);
    }
  }

  function apply({ s, tops, tail, beforeAt, afterAt }) {
    const fresh = !s.tops;
    own(s, s.tops || [], false);
    s.tops = tops;
    s.tail = tail;
    s.beforeAt = beforeAt;
    s.afterAt = afterAt;
    own(s, tops, true);

    // Everything before the first unfinished step may fold (the line sits at the stretch's start).
    const firstLive = tops.findIndex(active);
    let folded = firstLive < 0 ? tops : tops.slice(0, firstLive);
    // Oldest first, and only what has been seen long enough; the rest waits for the timer.
    const at = performance.now();
    let wait = 0, ready = 0;
    for (; ready < folded.length; ready++) {
      wait = remaining(folded[ready], at);
      if (wait > 0) break;
    }
    folded = folded.slice(0, ready);
    s.waitUntil = wait > 0 ? at + wait : 0;
    if (wait > 0) recheck(wait);

    const els = folded.map((t) => t.b.el).filter(Boolean), now = new Set(els), was = new Set(s.hidden);
    const motion = animateNow && !fresh && !s.open ? capture(els.filter((el) => !was.has(el))) : null;
    s.foldIds = folded.map((t) => t.b.id);
    const found = tally(folded);
    s.foldHead = found.steps || found.helpers ? s.foldIds[0] : null;
    view.setFold(s.key, s.foldIds.length ? { ids: s.foldIds, headId: s.foldHead, open: s.open } : null);
    for (const el of s.hidden) if (!now.has(el)) el.classList.remove('f-in', 'f-open', 'f-head');
    for (const el of els) {
      el.classList.add('f-in');
      el.classList.toggle('f-open', s.open);
    }
    s.hidden = els;

    // Thoughts alone leave nothing behind; work leaves a line.
    // An offscreen head keeps only its logical fold and placeholder, not a detached summary.
    const head = folded[0]?.b.el;
    if ((!found.steps && !found.helpers) || !head) {
      s.head?.classList.remove('f-head');
      s.head = null;
      removeLine(s);
      return;
    }
    const lineNew = !s.line;
    if (lineNew) s.line = makeLine(s);
    const html = mainHtml(found);
    if (html !== s.mainHtml) { s.main.innerHTML = html; s.mainHtml = html; s.line.title = mainWords(found); }
    let seconds = 0;
    if (!tail) seconds = beforeAt && afterAt > beforeAt ? (afterAt - beforeAt) / 1000 : 0;
    else if (beforeAt && running(tops)) seconds = (Date.now() - beforeAt) / 1000;
    const time = seconds > 0 && seconds < 86400 ? clock(seconds) : '';
    if (s.timeEl.textContent !== time) s.timeEl.textContent = time;
    showThumbs(s, found.images);
    paintOpen(s);
    // The line sits first inside the stretch's first block, which shows only the line while folded.
    if (s.head && s.head !== head) s.head.classList.remove('f-head');
    head.classList.add('f-head');
    if (s.line.parentElement !== head) head.prepend(s.line);
    s.head = head;
    play(s, motion, lineNew);
  }

  function create(key) {
    return { key, tops: null, foldIds: [], hidden: [], head: null, open: opened.has(key), line: null, tail: null, beforeAt: -1, afterAt: -1, waitUntil: 0, keepSig: '', mainHtml: null, thumbSig: null, thumbs: new Map(), chev: null, main: null, thumbBox: null, timeEl: null };
  }

  // One pass over all records. Top-level work blocks (and the steps nested in groups) form
  // stretches between prompts, replies and notices; only changed stretches are collected.
  function run() {
    const list = view.records(), ids = new Set(list.map((b) => b.id));
    const dirty = [], seen = new Set();
    const at = performance.now();
    for (const b of list) {
      if (!b.el && !b.instant) continue;
      if (!seenAt.has(b.id)) seenAt.set(b.id, b.instant ? -Infinity : at);
      if (!pictureAt.has(b.id) && b.ev.step?.thumbs?.length) pictureAt.set(b.id, b.instant ? -Infinity : at);
    }
    if (seenAt.size > 6000) {
      for (const id of seenAt.keys()) if (!ids.has(id)) { seenAt.delete(id); pictureAt.delete(id); }
    }
    let cur = null, before = null, top = null;
    const settle = (after) => {
      const key = cur.tops[0].b.id;
      seen.add(key);
      let s = stretches.get(key);
      if (!s) { s = create(key); stretches.set(key, s); }
      const tail = !after, beforeAt = cur.beforeAt, afterAt = after?.ev.at || 0;
      const due = s.waitUntil && at >= s.waitUntil;
      const keepSig = cur.tops.map((t) => active(t) ? 1 : 0).join('');
      if (!due && s.tops && s.keepSig === keepSig && s.tail === tail && s.beforeAt === beforeAt && s.afterAt === afterAt && same(s.tops, cur.tops)) {
        if (s.waitUntil > at) recheck(s.waitUntil - at);
        return;
      }
      s.keepSig = keepSig;
      dirty.push({ s, tops: cur.tops, tail, beforeAt, afterAt });
    };
    for (const b of list) {
      // records() is depth-first, so nested steps belong to the preceding logical top.
      if (b.ev.parent && ids.has(b.ev.parent)) {
        if (top && b.kind === 'step') (top.kids ||= []).push(b);
        continue;
      }
      if (WORK.has(b.kind)) {
        top = { b, kids: null };
        (cur ||= { tops: [], beforeAt: before?.ev.at || 0 }).tops.push(top);
        continue;
      }
      top = null;
      if (cur) { settle(b); cur = null; }
      before = b;
    }
    if (cur) settle(null);

    const gone = [];
    for (const s of stretches.values()) if (!seen.has(s.key)) gone.push(s);
    if (!dirty.length && !gone.length) return;
    // A reader who scrolled up keeps their place while stretches above fold.
    const root = view.root;
    const away = root.scrollHeight - root.clientHeight - root.scrollTop > 2;
    // Folds close with motion only for a reader at the bottom of a visible page; anyone scrolled
    // up keeps their place exactly, so for them it is instant.
    animateNow = !away && !document.hidden && !root.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    keepPlace(away ? anchor() : null, () => {
      for (const s of gone) drop(s);
      for (const item of dirty) apply(item);
    });
  }

  view.onChange(() => {
    try { run(); } catch (err) { fail(err); }
  });

  // Jumping to a block inside a folded stretch (find, outline) opens its stretch first.
  const jump = view.scrollToBlock;
  view.scrollToBlock = (id, options) => {
    try {
      const s = owner.get(id);
      if (s && !s.open) {
        setOpen(s, true);
        log('fold.toggle', { id: s.key, open: true, by: 'jump' });
      }
    } catch (err) { fail(err); }
    return jump(id, options);
  };
})();
