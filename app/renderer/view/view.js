'use strict';

(() => {
  const root = document.getElementById('view');
  const column = document.createElement('div');
  column.id = 'view-column';
  root.appendChild(column);
  // The working line shows a ring and clock between active blocks.
  const nowEl = document.createElement('div');
  nowEl.className = 'view-now';
  nowEl.hidden = true;
  nowEl.innerHTML = '<span class="r7-ring"></span><span class="view-now-label">Thinking</span><span class="view-now-clock"></span>';
  column.appendChild(nowEl);
  const tail = document.createElement('div');
  tail.style.cssText = 'height:0;flex:none;pointer-events:none';
  column.appendChild(tail);
  const nowClock = nowEl.lastChild;
  let nowSince = performance.now(), nowTimer = 0;
  const store = new Map(), retained = new Map(), kinds = new Map(), listeners = new Set();
  const animated = new Set();
  const animations = new Set(), reveals = new Map(), revealState = new WeakMap();
  const roles = ['bg', 'panel', 'user', 'subtle', 'text', 'bright', 'muted', 'dim', 'accent', 'outer', 'link', 'gold', 'success', 'error', 'warn', 'question', 'folder'];
  const theme = Object.fromEntries(roles.map((name) => [name, `var(--${name})`]));
  // Share of the input box's side margins the page keeps on each side.
  const PAGE_MARGIN = 0.5;
  // The last page width sent to the harness.
  let widthKey = '';
  let enabled = false, fontsReady = false, frame = 0, following = true;
  let dispatch = null, replayPending = false, replayStarted = 0, layoutKey = '';
  let order = [], dockHeight = 0, liveRoles = null;
  let previewRoles = null, confirmedRoles = false;
  const sameRoles = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every((key) => a[key] === b[key]);
  let needsArrange = true;
  let perfTimer = 0, perfDirty = false, eventsApplied = 0, longestBatch = 0;
  let shifts = 0, maxShiftDy = 0;
  let lastPerf = performance.now();
  // Offscreen records keep their measured space, not their rendered descendants.
  let tree = { children: new Map(), tops: [] }, viewFrame = 0;
  const mounted = new Set(), keepAll = new Set(), dirty = new Set();
  const folds = new Map(), foldById = new Map();
  let readingAnchor = null, themePending = false, columnChars = 80, jumpTarget = null;
  let jumpOptions = null;
  const themeValues = new Map();
  let changePending = false, contentChanged = false;
  // True while a batch is backlog (replay, first attach, hidden window, fonts not ready): no animation.
  let batchInstant = true;
  // Opening: the page stays invisible until the blocks are built and the bottom is stable.
  let opening = false, openReady = false, openFrame = 0, openStart = 0;
  let lastBox = null, boxMiss = 0;
  // The page's bottom edge: `appliedBottom` is what the CSS has now, `settledBottom` where it is heading.
  let appliedBottom = null, settledBottom = null, easeStop = null;
  let contentHeight = 0, followSpace = 0, viewportHeight = 0, syncing = false;
  let followAnchor = null, virtualShift = 0;
  let readingDown = false;
  let resizeContainersPending = false;
  let trimSpacePending = '';
  let lastDock = 0, imageAt = 0, seen = null;
  const shiftAt = {};
  const EASE_MS = 150, RELEASE_MS = 300;
  // Limit empty space after content shrinks by sliding older text down.
  const VACANCY_SHARE = 1 / 3;
  // A batch that removes or resets blocks rebuilds history (compaction, refresh): it never banks room.
  let historyBatch = false;
  // What changed the layout since the last pass, and the growth not yet logged (view.vacancy).
  const spaceBy = new Set(), spaceEpisode = new Set();
  let spaceMark = 0, spaceCapped = 0, spaceLogAt = 0;

  function log(name, fields = {}) {
    r7.log('info', name, { session: cfg.session, ...fields });
  }
  function error(name, err, fields = {}) {
    r7.log('error', name, { session: cfg.session, ...fields, error: String(err?.stack || err) });
  }
  function debug() {
    try {
      if (localStorage.r7ViewDebug !== '1') return false;
      const until = Number(localStorage.r7ViewDebugUntil);
      if (!Number.isFinite(until) || until <= 0) {
        localStorage.r7ViewDebugUntil = String(Date.now() + 10 * 60 * 1000);
        log('view.debug_on', { ttl_ms: 10 * 60 * 1000 });
        return true;
      }
      if (Date.now() < until) return true;
      localStorage.removeItem('r7ViewDebug');
      localStorage.removeItem('r7ViewDebugUntil');
      log('view.debug_off', { reason: 'ttl' });
    } catch { /* Storage unavailable: deep logging stays off. */ }
    return false;
  }
  const ctx = {
    rowHeight: 22, cellWidth: 9, theme, log, now: () => performance.now(),
  };
  function animateOnce(block, kind, fn) {
    if (block.ctx.instant || block.ctx.replay || document.hidden) return false;
    const state = kind === 'enter' || kind === 'arrive' ? '' : block.ev.state || block.ev.step?.status || '';
    const key = `${block.id}:${kind}:${state}`;
    if (animated.has(key)) return false;
    animated.add(key);
    while (animated.size > 16000) animated.delete(animated.values().next().value);
    fn();
    if (debug()) log('view.anim', { id: block.id, kind, state });
    return true;
  }
  function visible() { return !document.hidden && !root.hidden; }
  function queuePerf() {
    if (perfTimer || !perfDirty || !visible()) return;
    perfTimer = setTimeout(() => {
      perfTimer = 0;
      if (!visible() || !perfDirty) return;
      log('view.perf', {
        events_applied: eventsApplied, blocks: store.size, mounted: mounted.size,
        following, vacancy_px: Math.round(followSpace),
        dom_nodes: root.getElementsByTagName('*').length + 1,
        active_animations: document.getAnimations().filter((a) => a.playState === 'running').length,
        longest_batch_ms: Math.round(longestBatch * 100) / 100,
        ...(shifts ? { shifts, max_shift_dy: Math.round(maxShiftDy) } : {}),
      });
      eventsApplied = 0;
      longestBatch = 0;
      shifts = 0;
      maxShiftDy = 0;
      perfDirty = false;
      lastPerf = performance.now();
    }, Math.max(0, 30000 - (performance.now() - lastPerf)));
  }
  function stopPerf() {
    clearTimeout(perfTimer);
    perfTimer = 0;
  }
  // Autoscroll on or off, logged once per change with what caused it.
  function setFollowing(on, by) {
    if (following === on) return;
    following = on;
    followAnchor = null;
    if (!on) stopEase();
    log('view.follow', { on, by });
    queueView();
  }
  function resetFollowSpace() {
    contentHeight = followSpace = viewportHeight = 0;
    virtualShift = 0;
    followAnchor = null;
    spaceMark = spaceCapped = 0;
    spaceEpisode.clear();
    column.style.removeProperty('--follow-height');
  }
  function noteSpace(by, id) {
    if (spaceBy.size < 6) spaceBy.add(id ? `${by}:${String(id).slice(0, 48)}` : by);
  }
  // One warn line per quarter page of vacancy growth (or capped room), naming what made it.
  function watchSpace(made, anchor, viewport, viewportDelta) {
    if (viewportDelta > 0) spaceEpisode.add('viewport');
    if (made > 0) {
      for (const by of spaceBy) spaceEpisode.add(by);
      if (performance.now() - imageAt < 800) spaceEpisode.add('image');
    }
    spaceBy.clear();
    if (followSpace < spaceMark) {
      spaceMark = followSpace;
      spaceCapped = 0;
      spaceEpisode.clear();
    }
    if (followSpace - spaceMark <= viewport / 4 && spaceCapped <= viewport / 4) return;
    if (performance.now() - spaceLogAt < 1000) return;
    spaceLogAt = performance.now();
    r7.log('warn', 'view.vacancy', {
      session: cfg.session, by: spaceEpisode.size ? [...spaceEpisode].slice(0, 6) : ['unknown'],
      from_px: Math.round(spaceMark), to_px: Math.round(followSpace), capped_px: Math.round(spaceCapped),
      viewport: Math.round(viewport), anchor, following, busy: !!window.r7Busy,
    });
    spaceMark = followSpace;
    spaceCapped = 0;
    spaceEpisode.clear();
  }
  function requestSpaceTrim(by) {
    trimSpacePending = by;
    queueView();
  }
  function trimSpace() {
    if (!trimSpacePending) return;
    const box = currentBox();
    // A sent multiline draft must finish clearing before its released room
    // is discarded, otherwise the next input box redraw would bank it again.
    if (trimSpacePending === 'start' && (!box || box.bottom - box.top > 1)) return;
    const by = trimSpacePending, discarded = followSpace;
    trimSpacePending = '';
    stopEase();
    if (settledBottom !== null) setBottom(settledBottom);
    resetFollowSpace();
    stickToBottom();
    log('view.space_trim', { by, discarded_px: Math.round(discarded) });
  }
  function queueView() {
    if (!viewFrame && fontsReady && !document.hidden) viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      flush();
    });
  }
  function naturalHeight() {
    return tail.getBoundingClientRect().top - column.getBoundingClientRect().top + 8;
  }
  function historyBefore(block) {
    const previous = !parentOf(block) ? tree.tops[topIndex.get(block.id) - 1] : null;
    if (previous?.historyLayout && previous.el?.parentNode === column) measure(previous);
    return { height: naturalHeight(), previous };
  }
  function rebaseHistory(before, block) {
    if (before === null) return;
    const dy = naturalHeight() - before.height;
    contentHeight += dy;
    virtualShift += dy;
    // Inserting a folded head also changes the preceding reply's margin.
    // That change is already included in the whole-column correction.
    const previous = before.previous;
    if (previous?.historyLayout && previous.el?.parentNode === column) {
      previous.layoutHeight = outerHeight(previous.el);
    }
    // Nested replacements resize their ancestors too. The later observer
    // notification must not account for that same correction twice.
    const zoom = window.r7Zoom?.get('page') || 1;
    for (let parent = parentOf(block); parent; parent = parentOf(parent)) {
      if (parent.height) parent.height += dy / zoom;
      if (parent.layoutEl === parent.el) parent.layoutHeight += dy;
    }
  }
  function stickToBottom() {
    if (!visible()) return;
    if (syncing) {
      if (following) root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
      return;
    }
    // Commit historical card sizes before the column and anchor baselines.
    // A later resize delivery must not count those same pixels again.
    for (const block of mounted) {
      if (block.historyLayout && block.el?.parentNode === column) measure(block);
    }
    let anchorTop = null, anchor = 'none';
    const before = followSpace;
    if (following && !opening && followAnchor?.el === followAnchor?.block.el &&
        followAnchor?.el?.isConnected && !hiddenByFold(followAnchor.block)) {
      const rect = followAnchor.el.getBoundingClientRect();
      if (rect.height) {
        anchorTop = rect.top + root.scrollTop;
        anchor = 'held';
        const dy = anchorTop - followAnchor.top - virtualShift;
        followSpace += Math.max(0, dy);
        contentHeight += Math.min(0, dy);
      }
    } else if (followAnchor) anchor = !followAnchor.el?.isConnected ? 'gone' : hiddenByFold(followAnchor.block) ? 'folded' : 'none';
    virtualShift = 0;
    const height = naturalHeight();
    const nextViewport = root.clientHeight;
    const viewportDelta = following && viewportHeight && contentHeight + followSpace > viewportHeight
      ? nextViewport - viewportHeight : 0;
    let made = 0;
    if (opening || !contentHeight) {
      contentHeight = height;
      followSpace = 0;
    } else {
      // A growing dock or input box reuses room left when it shrank.
      // History measurements rebase contentHeight separately, never bank space.
      made = historyBatch ? 0 : followSpace - before + contentHeight - height;
      let next = Math.max(0, before + made + viewportDelta);
      const limit = Math.max(before + Math.max(0, viewportDelta), nextViewport * VACANCY_SHARE);
      if (made > 0 && next > limit) {
        spaceCapped += next - limit;
        next = limit;
      }
      followSpace = next;
      contentHeight = height;
    }
    // Final folds and dock departures can finish after the response ends.
    // Idle layout never carries saved room into the next response.
    if (window.r7Busy === false) followSpace = 0;
    watchSpace(made, anchor, nextViewport, viewportDelta);
    viewportHeight = nextViewport;
    if (anchorTop !== null) followAnchor.top = anchorTop;
    column.style.setProperty('--follow-height', `${height + followSpace}px`);
    if (!following) return;
    // keys.css makes #view scroll smoothly; following must jump.
    root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
  }
  // Count shifts in the perf sample; deep mode adds at most one line per 500ms per cause.
  // by: dock | box | chrome | content | image | mount. dy > 0 moves text down.
  function shiftLog(by, dy, extra = {}) {
    shifts++;
    maxShiftDy = Math.max(maxShiftDy, Math.abs(dy));
    perfDirty = true;
    queuePerf();
    if (!debug()) return;
    const now = performance.now();
    if (now - (shiftAt[by] ?? -1e9) < 500) return;
    shiftAt[by] = now;
    log('view.shift', { by, dy: Math.round(dy), bottom: appliedBottom, dock: dockHeight, ...extra });
  }
  function setBottom(px) {
    appliedBottom = px;
    root.style.bottom = `${px}px`;
  }
  function stopEase() {
    if (easeStop) { easeStop(); easeStop = null; }
  }
  function easeTo(target, ms) {
    stopEase();
    const from = appliedBottom, start = performance.now();
    settledBottom = target;
    easeStop = animate((now) => {
      const p = Math.min(1, Math.max(0, (now - start) / ms));
      setBottom(Math.round(from + (target - from) * p * p * (3 - 2 * p)));
      stickToBottom();
      if (p < 1) return true;
      easeStop = null;
      return false;
    }, 'view-bottom');
  }
  // Dock and input box changes still ease; a shrinking dock leaves bottom vacancy
  // instead of releasing the transcript downward after a delay.
  function fitBottom(target, by, now) {
    if (now || appliedBottom === null || !following || opening || !visible()) {
      stopEase();
      setBottom(target);
      settledBottom = target;
      return;
    }
    if (target === settledBottom) return;
    if (target > settledBottom) shiftLog(by, settledBottom - target, { how: 'ease' });
    easeTo(target, target > settledBottom ? EASE_MS : RELEASE_MS);
  }
  // Content moving the text without a new block at the end: an image loading, a row settling, a block removed.
  function noteContent() {
    const last = nowEl.previousElementSibling;
    const next = { height: root.scrollHeight, count: column.childElementCount, last, lastTop: last ? last.offsetTop : 0 };
    const prev = seen;
    seen = next;
    if (!prev || !following || opening || !visible() || next.height <= root.clientHeight + 2) return;
    const d = next.height - prev.height;
    if (Math.abs(d) <= 2) return;
    // Growth inside the last block, or a block appended, is new content: the text is meant to move up.
    const before = next.last === prev.last && next.count === prev.count && Math.abs(next.lastTop - prev.lastTop) >= d - 2;
    if (d > 0 && !before && next.count >= prev.count) return;
    shiftLog(performance.now() - imageAt < 800 ? 'image' : 'content', -d);
  }
  function schedule() {
    if (!frame && animations.size && visible()) frame = requestAnimationFrame(tick);
  }
  function tick(now) {
    frame = 0;
    if (!visible()) return;
    for (const item of [...animations]) {
      if (!animations.has(item)) continue;
      try { if (item.fn(now) === false) animations.delete(item); }
      catch (err) { animations.delete(item); error('view.animation', err); }
    }
    schedule();
  }
  function animate(fn, owner = dispatch?.id) {
    const item = { fn, owner };
    animations.add(item);
    schedule();
    return () => {
      animations.delete(item);
      if (!animations.size && frame) { cancelAnimationFrame(frame); frame = 0; }
    };
  }
  function finishReveals(el) {
    for (const [leaf, control] of reveals) if (el === leaf || el.contains(leaf)) control.finish();
  }
  function stopBlock(block) {
    if (block.el) finishReveals(block.el);
    for (const item of animations) if (item.owner === block.id) animations.delete(item);
    if (!animations.size && frame) { cancelAnimationFrame(frame); frame = 0; }
  }

  // Only the leaf's text node changes; links and the surrounding markup stay intact.
  function typeReveal(el, value, options = {}) {
    const text = String(value ?? '');
    const old = revealState.get(el);
    if (old?.text === text && reveals.has(el)) return old.control;
    old?.control?.();
    let count = 0;
    const shown = old?.shown || '';
    while (count < shown.length && count < text.length && shown[count] === text[count]) count++;
    const node = el.firstChild?.nodeType === Node.TEXT_NODE ? el.firstChild : document.createTextNode('');
    if (node.parentNode !== el) el.prepend(node);
    function paint(value) {
      const before = node.data;
      let from = 0;
      while (from < before.length && from < value.length && before[from] === value[from]) from++;
      if (from !== before.length || from !== value.length) node.replaceData(from, before.length - from, value.slice(from));
    }
    const caret = document.createElement('i');
    caret.className = 'view-type-caret tc';
    caret.setAttribute('aria-hidden', 'true');
    const deadline = performance.now() + 1000;
    const start = performance.now() + Math.max(0, Number(options.startDelayMs) || 0);
    const cps = Math.max(1, Number(options.cps) || 110);
    let lastStep = -1, stopAnimation = () => {}, finished = false;
    const state = { text, shown: text.slice(0, count), control: null };
    const initial = count;
    paint(state.shown);
    const control = () => {
      stopAnimation();
      caret.remove();
      reveals.delete(el);
    };
    control.cancel = control;
    control.finish = () => {
      if (finished) return;
      finished = true;
      paint(text);
      state.shown = text;
      control();
    };
    state.control = control;
    revealState.set(el, state);
    // A sealed (complete) text still types in live; only backlog and hidden windows skip it.
    if (dispatch?.instant || dispatch?.replay || (dispatch?.sealed && !dispatch?.revealSealed) || document.hidden || text === state.shown) {
      control.finish();
      return control;
    }
    caret.hidden = true;
    el.appendChild(caret);
    reveals.set(el, control);
    let lastTick = performance.now();
    stopAnimation = animate((now) => {
      if (!el.isConnected) { control(); return false; }
      if (now - lastTick > 1000 || now >= deadline) { control.finish(); return false; }
      lastTick = now;
      if (now < start) return true;
      caret.hidden = false;
      const step = Math.floor((now - start) * 30 / 1000);
      if (step === lastStep) return true;
      lastStep = step;
      count = Math.min(text.length, initial + Math.floor((step + 1) * cps / 30));
      if (count < text.length && /[\uD800-\uDBFF]/.test(text[count - 1])) count++;
      state.shown = text.slice(0, count);
      paint(state.shown);
      if (count >= text.length) { control.finish(); return false; }
      return true;
    });
    const key = `${dispatch?.id || ''}:type`;
    if (dispatch?.id && !animated.has(key)) {
      animated.add(key);
      while (animated.size > 16000) animated.delete(animated.values().next().value);
      if (debug()) log('view.anim', { id: dispatch.id, kind: 'type' });
    }
    return control;
  }

  // `instant` marks backlog (replay, attach, hidden window): listeners treat it as already seen.
  function records() { return order.map((id) => store.get(id)).filter(Boolean).map(({ id, ev, el, ctx }) => ({ id, kind: ev.kind, el, ev, instant: !!ctx?.instant })); }
  function blocks() { return records().filter((b) => b.el); }
  function changed() {
    if (!changePending) return;
    changePending = false;
    // Rebuilding history also restores fold classes and neighbouring margins.
    // Those listener changes refine its layout, not the amount of new content.
    const history = !contentChanged && contentHeight > 0;
    contentChanged = false;
    if (history) for (const block of mounted) measure(block);
    const before = history ? naturalHeight() : null;
    const snapshot = blocks();
    for (const fn of listeners) {
      try { fn(snapshot); } catch (err) { error('view.change', err); }
    }
    if (before !== null && !contentChanged) {
      contentHeight += naturalHeight() - before;
      for (const block of mounted) {
        if (block.el?.isConnected) {
          block.layoutEl = block.el;
          block.layoutHeight = outerHeight(block.el);
        }
      }
      if (followAnchor?.el === followAnchor?.block.el && followAnchor?.el.isConnected) {
        followAnchor.top = followAnchor.el.getBoundingClientRect().top + root.scrollTop;
        virtualShift = 0;
      }
      stickToBottom();
    }
  }
  function removeBlock(block) {
    contentChanged = true;
    changePending = true;
    stopBlock(block);
    for (const animation of block.el?.getAnimations({ subtree: true }) || []) animation.cancel();
    if (block.el) resize.unobserve(block.el);
    block.el?.remove();
    block.placeholder?.remove();
    mounted.delete(block);
    dirty.delete(block);
    store.delete(block.id);
    needsArrange = true;
  }
  function clear() {
    stopEase();
    for (const control of [...reveals.values()]) control.cancel();
    animations.clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const block of store.values()) {
      unbuild(block);
      removeBlock(block);
      retained.set(block.id, block);
    }
    while (retained.size > 2000) retained.delete(retained.keys().next().value);
    order = [];
    tree = { children: new Map(), tops: [] };
    topIndex.clear();
    layoutTops();
    readingAnchor = null;
    jumpTarget = null;
    jumpOptions = null;
    readingDown = false;
    following = true;
    trimSpacePending = '';
    resetFollowSpace();
    seen = null;
    lastBox = null;
    boxMiss = 0;
    layoutKey = '';
    appliedBottom = settledBottom = null;
    root.style.removeProperty('bottom');
    root.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    clearTimeout(nowTimer);
    nowTimer = 0;
    nowEl.hidden = true;
    nowEl.classList.remove('view-now-reserved');
    needsArrange = changePending = true;
    window.dispatchEvent(new Event('r7-view-reset'));
  }
  // A block and everything nested under it.
  function withDescendants(id) {
    const ids = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const block of store.values()) {
        if (ids.has(block.id) || !ids.has(block.ev.parent)) continue;
        ids.add(block.id);
        grew = true;
      }
    }
    return ids;
  }
  function dropBlocks(id) {
    retained.delete(id);
    if (!store.has(id)) return;
    const ids = withDescendants(id);
    for (const gone of ids) removeBlock(store.get(gone));
  }
  function reduce(ev) {
    if (ev.type !== 'theme') contentChanged = true;
    if (ev.op === 'reset') { clear(); return; }
    if (ev.op === 'remove') { dropBlocks(ev.id); return; }
    if (ev.type === 'theme') {
      liveRoles = { ...ev.roles };
      if (confirmedRoles && sameRoles(previewRoles, liveRoles)) { previewRoles = null; confirmedRoles = false; }
      updateTheme();
      return;
    }
    changePending = true;
    if (ev.kind === 'compaction') noteSpace('compaction');
    // A new user message brings the page back to the bottom.
    if (ev.kind === 'user' && ev.op === 'upsert' && !replayPending && !store.has(ev.id) && !retained.has(ev.id)) {
      setFollowing(true, 'send');
      requestSpaceTrim('start');
    }
    let block = store.get(ev.id);
    if (!block && retained.has(ev.id)) {
      block = retained.get(ev.id);
      retained.delete(ev.id);
      block.restored = true;
      store.set(ev.id, block);
      needsArrange = true;
    }
    if (block && block.ev.kind !== ev.kind) throw new Error(`block kind changed: ${ev.id}`);
    if (ev.op !== 'upsert' && !block) throw new Error(`missing block: ${ev.id}`);
    const next = ev.op === 'upsert' ? { ...ev } : { ...block.ev, ...ev };
    if (!block || next.parent !== block.ev.parent || JSON.stringify(next.members) !== JSON.stringify(block.ev.members)) needsArrange = true;
    if (ev.op === 'append') {
      const text = String(block.ev.text ?? block.ev.md ?? '');
      if (ev.offset > text.length) throw new Error(`append gap: ${ev.id}`);
      next.text = text.slice(0, ev.offset) + ev.chunk + text.slice(ev.offset + ev.chunk.length);
      if (next.kind === 'reply') delete next.md;
    }
    if (ev.op === 'seal') {
      next.sealed = true;
      if (typeof ev.md === 'string') next.text = ev.md;
    }
    if (block) { block.ev = next; block.dirty = true; block.instant ||= batchInstant; }
    else store.set(ev.id, { id: ev.id, ev: next, el: null, rendered: null, dirty: true, instant: batchInstant, newLive: !batchInstant });
    dirty.add(store.get(ev.id));
  }
  // The block a child nests under, or null for a top-level block. An unbuilt parent is assumed
  // to host its children; a built one must have a members host.
  function parentOf(block) {
    if (!block.ev.parent) return null;
    const parent = store.get(block.ev.parent);
    if (!parent) return null;
    const seen = new Set([block.id]);
    for (let p = parent; p; p = store.get(p.ev.parent)) {
      if (seen.has(p.id)) return null;
      seen.add(p.id);
    }
    if (parent.el && !parent.el.querySelector('[data-view-members]')) return null;
    return parent;
  }
  function structure() {
    const children = new Map(), tops = [];
    for (const block of store.values()) {
      const parent = parentOf(block);
      if (!parent) { tops.push(block); continue; }
      if (!children.has(parent.id)) children.set(parent.id, []);
      children.get(parent.id).push(block);
    }
    return { children, tops };
  }
  function hiddenByFold(block) {
    const seen = new Set();
    for (let item = block; item && !seen.has(item.id); item = store.get(item.ev.parent)) {
      seen.add(item.id);
      const fold = foldById.get(item.id);
      if (fold && !fold.open && (item !== block || fold.headId !== item.id)) return true;
    }
    return false;
  }
  function closedHead(block) {
    const fold = foldById.get(block.id);
    return fold && !fold.open && fold.headId === block.id;
  }
  function setFold(key, value) {
    const old = folds.get(key);
    const ids = value?.ids?.slice() || [];
    const next = ids.length ? { ids, headId: value.headId === null ? null : value.headId || ids[0], open: !!value.open } : null;
    if (!old && !next) return;
    if (old && next && old.headId === next.headId && old.open === next.open &&
        old.ids.length === ids.length && old.ids.every((id, i) => id === ids[i])) return;
    contentChanged = true;
    noteSpace(next && !next.open ? 'fold' : 'unfold', key);
    // Capture natural sizes before fold.js changes the mounted cards' classes.
    const affected = new Set([...(old?.ids || []), ...ids]);
    for (const id of affected) {
      const block = store.get(id);
      if (block) { measure(block); block.historyLayout = false; }
      for (const child of tree.children.get(id) || []) affected.add(child.id);
    }
    if (old) for (const id of old.ids) if (foldById.get(id) === old) foldById.delete(id);
    if (next) {
      folds.set(key, next);
      for (const id of ids) foldById.set(id, next);
    } else folds.delete(key);
    // Slots change immediately; rendering and listener notification stay in the queued pass.
    for (const id of affected) {
      const block = store.get(id);
      if (block?.placeholder) placeholder(block);
    }
    spacersResize = true;
    changePending = true;
    queueView();
  }
  function placeholder(block) {
    if (!block.placeholder) {
      block.placeholder = document.createElement('div');
      block.placeholder.className = 'view-placeholder';
      block.placeholder.dataset.placeholderId = block.id;
      block.placeholder.setAttribute('aria-hidden', 'true');
    }
    const fold = foldById.get(block.id), hidden = hiddenByFold(block);
    block.placeholder.classList.toggle('f-in', !!fold);
    block.placeholder.classList.toggle('f-head', fold?.headId === block.id);
    block.placeholder.classList.toggle('f-open', !!fold?.open);
    block.placeholder.style.display = hidden ? 'none' : '';
    if (hidden || closedHead(block)) {
      block.placeholder.style.height = `${hidden ? 0 : block.foldHeight || 26}px`;
      return block.placeholder;
    }
    block.placeholder.style.height = `${slotHeight(block)}px`;
    return block.placeholder;
  }
  // The room an unbuilt block keeps: nothing while folded away, its summary line when it heads a
  // closed fold, its last measured size, or for history never seen an estimate from its text at
  // the current column width.
  function slotHeight(block) {
    if (hiddenByFold(block)) return 0;
    if (closedHead(block)) return block.foldHeight || 26;
    // Its last size at this width and open state, even if its event changed since it left the page.
    const key = block.measureKey;
    if (key && key.chars === columnChars && key.expanded === block.expanded) return block.height;
    // Notices show one line (their full text only when opened).
    const oneLine = !block.expanded && ['compaction', 'notice', 'done'].includes(block.ev.kind);
    const text = oneLine ? '' : String(block.ev.text ?? block.ev.md ?? '');
    const lines = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / columnChars)), 0);
    return Math.max(ctx.rowHeight, lines * ctx.rowHeight);
  }

  // ---- spacers ----
  // Top-level blocks that aren't built keep no element of their own: each run of them between
  // built blocks is one spacer as tall as the run. A long chat is a few dozen elements instead of
  // thousands, so every layout of the column (a flex box lays out all its children) stays cheap.
  // A spacer covers tree.tops[from, to); topIndex and runOf are rebuilt with tree in arrange().
  const runOf = new Map(), topIndex = new Map(), spacerPool = [];
  let spacersStale = false;
  const isSpacer = (el) => el?.classList?.contains('view-spacer');
  function spacer(from, to) {
    const el = spacerPool.pop() || document.createElement('div');
    if (!el.className) { el.className = 'view-spacer'; el.setAttribute('aria-hidden', 'true'); }
    setRun(el, from, to);
    return el;
  }
  function setRun(el, from, to) {
    el.runFrom = from;
    el.runTo = to;
    let height = 0;
    for (let i = from; i < to; i++) { runOf.set(tree.tops[i], el); height += slotHeight(tree.tops[i]); }
    el.runHeight = height;
    const px = `${height}px`;
    if (el.style.height !== px) el.style.height = px;
  }
  function dropSpacer(el) {
    el.remove();
    if (spacerPool.length < 64) spacerPool.push(el);
  }
  // Puts every top-level block's element or its run's spacer in order, reusing what is in place.
  function layoutTops() {
    spacersStale = false;
    runOf.clear();
    const tops = tree.tops, old = [...column.children].filter(isSpacer), want = [];
    for (let i = 0; i < tops.length; i++) {
      const block = tops[i];
      if (block.placeholder?.parentNode === column) block.placeholder.remove();
      if (block.el) { want.push(block.el); continue; }
      let j = i + 1;
      while (j < tops.length && !tops[j].el) j++;
      const el = old.shift();
      if (el) setRun(el, i, j);
      want.push(el || spacer(i, j));
      i = j - 1;
    }
    for (const el of old) dropSpacer(el);
    let before = column.firstElementChild;
    for (const el of want) {
      if (before && before.parentNode !== column) before = null;
      if (el !== before) column.insertBefore(el, before);
      const nested = el.dataset?.viewId && el.querySelector('[data-view-members]');
      if (nested) place(tree.children.get(el.dataset.viewId) || [], nested);
      before = el.nextElementSibling;
    }
    if (nowEl.parentNode !== column || nowEl.nextElementSibling !== tail) column.insertBefore(nowEl, tail);
  }
  // A top-level block just built: its element takes its place inside its spacer, splitting it.
  function insertTop(block) {
    const run = runOf.get(block), i = topIndex.get(block.id);
    if (!run?.isConnected || i === undefined || i < run.runFrom || i >= run.runTo) { layoutTops(); return; }
    const from = run.runFrom, to = run.runTo;
    runOf.delete(block);
    run.after(block.el);
    if (i + 1 < to) block.el.after(spacer(i + 1, to));
    if (i > from) setRun(run, from, i); else dropSpacer(run);
  }
  // A top-level block taken off the page: its room joins the spacers on either side.
  function removeTop(block) {
    const el = block.el, i = topIndex.get(block.id);
    if (!el?.isConnected || el.parentNode !== column || i === undefined) { el?.remove(); spacersStale = true; return; }
    const prev = el.previousElementSibling, next = el.nextElementSibling;
    const left = isSpacer(prev) && prev.runTo === i ? prev : null, right = isSpacer(next) && next.runFrom === i + 1 ? next : null;
    const from = left ? left.runFrom : i, to = right ? right.runTo : i + 1;
    el.remove();
    if (left) {
      if (right) dropSpacer(right);
      setRun(left, from, to);
    } else if (right) setRun(right, from, to);
    else (next || nowEl).before(spacer(from, to));
  }
  // Sizes of unbuilt blocks changed (a fold, the column width, a block opened): resize the spacers.
  function sizeSpacers() {
    if (spacersStale) { layoutTops(); return; }
    for (const el of column.children) if (isSpacer(el)) setRun(el, el.runFrom, el.runTo);
  }
  let spacersResize = false;
  // Whether the block's last measurement still describes it: same text, column and open state.
  // Size changes after that reach measure() through the ResizeObserver below.
  function measured(block) {
    const key = block.measureKey;
    return !!key && key.chars === columnChars && key.ev === block.ev && key.expanded === block.expanded;
  }
  function outerHeight(el, rect = el.getBoundingClientRect(), style = getComputedStyle(el)) {
    const zoom = window.r7Zoom?.get('page') || 1;
    return rect.height + ((parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)) * zoom;
  }
  function measure(block) {
    if (!block.el?.isConnected || hiddenByFold(block)) return;
    const rect = block.el.getBoundingClientRect();
    if (!rect.height) return;
    const style = getComputedStyle(block.el);
    const zoom = window.r7Zoom?.get('page') || 1;
    const height = outerHeight(block.el, rect, style);
    if (block.historyLayout && block.el.parentNode === column &&
        block.layoutEl === block.el && Number.isFinite(block.layoutHeight)) {
      const dy = height - block.layoutHeight;
      contentHeight += dy;
      // Historical size correction and its anchor correction are one change.
      if (followAnchor?.el?.isConnected && !block.el.contains(followAnchor.el) &&
          (block.el.compareDocumentPosition(followAnchor.el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        virtualShift += dy;
      }
    }
    block.layoutEl = block.el;
    block.layoutHeight = height;
    block.sizeEvent = block.rendered;
    if (closedHead(block)) {
      // The folding ghost is transient; only the settled summary reserves offscreen room.
      if (block.el.classList.contains('f-head') && !block.el.classList.contains('f-open') &&
          !block.el.querySelector('.f-ghost')) {
        block.foldHeight = rect.height / zoom + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      }
      return;
    }
    if (block.el.classList.contains('f-in') && !block.el.classList.contains('f-open')) return;
    block.height = rect.height / zoom + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    block.measureKey = { chars: columnChars, ev: block.ev, expanded: block.expanded };
  }
  // The blocks within a quarter page of the screen. The column holds only built blocks and
  // spacers (a few dozen elements), so one pass reads their positions; inside a spacer the blocks
  // are found from their known sizes, and inside a built group from its members' places.
  // No observer watches every block: Chromium rechecked thousands of them each frame.
  function nearbyBlocks() {
    const out = [];
    const page = root.getBoundingClientRect(), margin = root.clientHeight / 4;
    const from = page.top - margin, to = page.bottom + margin;
    // A folded group's members are clipped out of sight: none of them is near.
    const visitKids = (block) => {
      if (block.el.matches('.c-folded, .c-auto-fold')) return;
      for (const kid of tree.children.get(block.id) || []) {
        const el = kid.el || kid.placeholder;
        if (!el?.isConnected || !el.getClientRects().length) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top > to) break;
        if (rect.bottom < from) continue;
        out.push(kid);
        if (kid.el) visitKids(kid);
      }
    };
    for (const el of column.children) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < from || !rect.height) continue;
      if (rect.top > to) break;
      if (isSpacer(el)) {
        const scale = el.runHeight ? rect.height / el.runHeight : 1;
        let y = rect.top;
        for (let i = el.runFrom; i < el.runTo && y <= to; i++) {
          const h = slotHeight(tree.tops[i]) * scale;
          if (h && y + h >= from) out.push(tree.tops[i]);
          y += h;
        }
        continue;
      }
      const block = store.get(el.dataset.viewId);
      if (!block) continue;
      out.push(block);
      visitKids(block);
    }
    return out;
  }
  // Where a block starts on screen (px from the viewport top), built or not; null when folded away.
  function blockTop(id) {
    const block = store.get(id);
    if (!block) return null;
    const el = block.el || block.placeholder;
    if (el?.isConnected) return el.getClientRects().length ? el.getBoundingClientRect().top : null;
    const run = runOf.get(block), i = topIndex.get(id);
    if (!run?.isConnected || i === undefined || !slotHeight(block)) return null;
    const rect = run.getBoundingClientRect(), scale = run.runHeight ? rect.height / run.runHeight : 1;
    let y = rect.top;
    for (let k = run.runFrom; k < i; k++) y += slotHeight(tree.tops[k]) * scale;
    return y;
  }
  function rememberAnchor() {
    if (following) { readingAnchor = null; stickToBottom(); return; }
    const top = root.getBoundingClientRect().top;
    let closest = Infinity;
    readingAnchor = null;
    for (const block of mounted) {
      const rect = block.el?.getBoundingClientRect();
      const distance = rect ? Math.abs(rect.top - top - (readingDown ? root.clientHeight : 0)) : Infinity;
      if (rect && rect.bottom > top && rect.top < top + root.clientHeight && distance <= closest) {
        closest = distance;
        readingAnchor = { block, top: rect.top + root.scrollTop };
      }
    }
  }
  function restoreAnchor(anchor) {
    if (following || jumpTarget || !anchor?.block.el?.isConnected) return;
    // Only content movement counts; scrolling may precede its queued scroll event.
    const dy = anchor.block.el.getBoundingClientRect().top + root.scrollTop - anchor.top;
    if (Math.abs(dy) > .5) root.scrollBy({ top: dy, behavior: 'instant' });
  }
  function alignJump() {
    if (!jumpTarget?.el?.isConnected) { jumpTarget = null; return; }
    const rect = jumpTarget.el.getBoundingClientRect(), page = root.getBoundingClientRect();
    const offset = jumpOptions?.block === 'start' ? jumpOptions.offset || 0 : (root.clientHeight - rect.height) / 2;
    const top = Math.max(0, Math.min(root.scrollHeight - root.clientHeight, root.scrollTop + rect.top - page.top - offset));
    if (Math.abs(root.scrollTop - top) <= 1) { jumpTarget = null; rememberAnchor(); return; }
    root.scrollTo({ top, behavior: 'smooth' });
  }
  function measureTree(block) {
    if (!block.el) return;
    if (block.el.dataset.expanded !== undefined) block.expanded = block.el.dataset.expanded === 'true';
    measure(block);
    for (const child of tree.children.get(block.id) || []) measureTree(child);
  }
  // `premeasured`: sync() already read this block and its children before any removal.
  // `running`: the page's animations, read once per batch; asking each removed block for its
  // own (getAnimations) recalculated the page's style once per block.
  function unbuild(block, premeasured = false, running = document.getAnimations()) {
    if (!block.el) return;
    changePending = true;
    if (block.el.dataset.expanded !== undefined) block.expanded = block.el.dataset.expanded === 'true';
    if (!premeasured) measure(block);
    for (const child of tree.children.get(block.id) || []) {
      unbuild(child, premeasured, running);
    }
    const before = contentHeight ? historyBefore(block) : null;
    stopBlock(block);
    for (const animation of running) {
      const target = animation.effect?.target;
      if (target && block.el.contains(target)) animation.cancel();
    }
    resize.unobserve(block.el);
    if (parentOf(block)) block.el.replaceWith(placeholder(block));
    else removeTop(block);
    mounted.delete(block);
    block.el = null;
    block.rendered = null;
    block.dirty = true;
    block.instant = true;
    rebaseHistory(before, block);
  }
  function mount(block, replay) {
    if (!keepAll.size && hiddenByFold(block)) return;
    // arrange() owns topology changes; a clean mounted group keeps its children and observers.
    if (block.el && !block.dirty && mounted.has(block)) return;
    const virtual = !block.el && !block.newLive &&
      (!block.sizeEvent || block.sizeEvent === block.ev);
    const before = virtual && contentHeight ? historyBefore(block) : null;
    if (!block.el || block.dirty) {
      try { render(block, replay); } catch (err) { error('view.render', err, { block: block.id, kind: block.ev.kind }); return; }
    }
    replyClasses(block);
    mounted.add(block);
    // parentNode, not isConnected: a group built in a bulk pass is still off the page.
    if (block.placeholder?.parentNode) block.placeholder.replaceWith(block.el);
    else if (!block.el.isConnected && !parentOf(block)) {
      insertTop(block);
    }
    resize.observe(block.el);
    const host = block.el.querySelector('[data-view-members]');
    if (host) place(tree.children.get(block.id) || [], host);
    rebaseHistory(before, block);
    block.layoutEl = block.el;
    block.layoutHeight = outerHeight(block.el);
  }
  function place(list, host) {
    let before = host.firstElementChild;
    for (const block of list) {
      const el = block.el || placeholder(block);
      if (before && before.parentNode !== host) before = null;
      if (el !== before) host.insertBefore(el, before);
      const nested = block.el?.querySelector('[data-view-members]');
      if (nested) place(tree.children.get(block.id) || [], nested);
      before = el.nextElementSibling;
    }
  }
  function sync(replay) {
    syncing = true;
    let nextFollowAnchor = null;
    if (needsArrange) arrange();
    let anchor = readingAnchor;
    if (spacersResize) { spacersResize = false; sizeSpacers(); }
    if (keepAll.size) {
      for (const id of order) mount(store.get(id), true);
      if (spacersStale) layoutTops();
    } else {
      const folded = [...mounted].filter(hiddenByFold);
      if (folded.length) {
        const running = document.getAnimations();
        for (const block of folded) unbuild(block, false, running);
      }
      // The bottom is measured backwards until a viewport and its buffer are filled.
      if (following) {
        let remaining = root.clientHeight * 1.25;
        for (let i = tree.tops.length - 1; i >= 0 && remaining > 0; i--) {
          const block = tree.tops[i];
          if (hiddenByFold(block)) continue;
          mount(block, replay);
          // Only a block that changed is read back (one layout); the rest keep their measured size.
          if (!measured(block)) measure(block);
          remaining -= (closedHead(block) ? block.foldHeight || 26 : block.height || ctx.rowHeight) * (window.r7Zoom?.get('page') || 1);
        }
        stickToBottom();
      }
      for (const block of nearbyBlocks()) mount(block, replay || block.instant);
      // The reader's place is held before deciding what is far away: a block that mounted taller
      // or shorter than its placeholder would otherwise push the whole screen past the drop line
      // (a compaction notice once took the screen with it and the page jumped by thousands of px).
      restoreAnchor(anchor);
      rememberAnchor();
      anchor = readingAnchor;
      // Every position is read before anything is taken off the page, so the pass costs one
      // layout instead of one per removed block.
      const page = root.getBoundingClientRect(), buffer = root.clientHeight / 4;
      const selection = window.getSelection();
      const drop = [];
      let lastTop = -Infinity;
      for (const block of [...mounted]) {
        if (!block.el) continue;
        const rect = block.el.getBoundingClientRect();
        const selected = selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(block.el);
        const jumping = jumpTarget?.el && block.el.contains(jumpTarget.el);
        const folded = block.el.parentElement?.closest('.c-folded');
        const held = following && followAnchor?.block === block && followAnchor.el === block.el;
        if (following && rect.height && rect.bottom > page.top && rect.top < page.bottom &&
            rect.top >= lastTop && !hiddenByFold(block)) {
          lastTop = rect.top;
          nextFollowAnchor = { block, el: block.el };
        }
        if (!held && !jumping && !selected && !block.el.contains(document.activeElement) && (folded || rect.bottom < page.top - buffer || rect.top > page.bottom + buffer)) drop.push(block);
      }
      for (const block of drop) measureTree(block);
      const running = drop.length ? document.getAnimations() : [];
      for (const block of drop) unbuild(block, true, running);
    }
    for (const block of dirty) {
      if (block.el) mount(block, replay);
      else block.instant = true;
      block.newLive = false;
    }
    dirty.clear();
    needsArrange = false;
    if (spacersStale) layoutTops();
    restoreAnchor(anchor);
    rememberAnchor();
    syncing = false;
    stickToBottom();
    followAnchor = following && nextFollowAnchor?.el === nextFollowAnchor?.block.el && nextFollowAnchor?.el.isConnected
      ? { ...nextFollowAnchor, top: nextFollowAnchor.el.getBoundingClientRect().top + root.scrollTop } : null;
  }
  function arrange() {
    columnChars = Math.max(1, Math.floor((column.clientWidth - 16) / ctx.cellWidth));
    tree = structure();
    order = [];
    function index(list, parentId) {
      const members = store.get(parentId)?.ev.members;
      if (Array.isArray(members)) {
        const indices = new Map(members.map((id, i) => [typeof id === 'string' ? id : id.id, i]));
        list.sort((a, b) => (indices.get(a.id) ?? Infinity) - (indices.get(b.id) ?? Infinity));
      }
      for (const block of list) {
        order.push(block.id);
        index(tree.children.get(block.id) || [], block.id);
      }
    }
    index(tree.tops, '');
    let lastReply = null;
    for (let i = 0; i < tree.tops.length; i++) {
      const block = tree.tops[i];
      block.afterWork = ['step', 'group'].includes(tree.tops[i - 1]?.ev.kind);
      block.latestReply = false;
      if (block.ev.kind === 'reply') lastReply = block;
    }
    if (lastReply) lastReply.latestReply = true;
    for (const block of mounted) replyClasses(block);
    topIndex.clear();
    tree.tops.forEach((block, i) => topIndex.set(block.id, i));
    layoutTops();
    needsArrange = false;
  }
  function replyClasses(block) {
    if (block.ev.kind !== 'reply' || !block.el) return;
    block.el.classList.toggle('reply-after-work', !!block.afterWork);
    block.el.classList.toggle('reply-latest', !!block.latestReply);
  }
  function render(block, replay) {
    changePending = true;
    const kind = kinds.get(block.ev.kind);
    if (!kind) throw new Error(`unregistered kind: ${block.ev.kind}`);
    const ev = block.ev;
    replay ||= !!block.restored;
    // Instant only for backlog (replay, attach, hidden window); every live event animates.
    dispatch = { id: block.id, replay, instant: replay || !!block.instant, sealed: ev.sealed || ev.op === 'seal', revealSealed: !!kind.revealSealed };
    block.historyLayout = dispatch.instant;
    block.ctx ||= { ...ctx, animate: (fn) => animate(fn, block.id), animateOnce: (name, fn) => animateOnce(block, name, fn) };
    block.ctx.instant = dispatch.instant;
    block.ctx.replay = replay;
    try {
      if (!block.el) {
        block.el = kind.create(ev, block.ctx);
        if (!(block.el instanceof HTMLElement)) throw new Error(`kind did not create an element: ${ev.kind}`);
        block.el.classList.add('view-block');
        block.el.dataset.viewId = block.id;
        block.el.dataset.viewKind = ev.kind;
        if (typeof block.expanded === 'boolean') kind.expand?.(block.el, ev, block.expanded);
        needsArrange = true;
      } else kind.patch(block.el, ev, block.rendered, block.ctx);
      block.el.dataset.state = ev.state || '';
      if (dispatch.instant) stopBlock(block);
      // Kinds that reveal their own sealed text live (replies) keep typing through the seal.
      if ((ev.op === 'seal' || ev.sealed) && !(kind.revealSealed && !dispatch.instant)) {
        stopBlock(block);
        kind.seal?.(block.el, ev);
      }
      block.rendered = ev;
      block.dirty = false;
      block.restored = false;
      block.instant = false;
    } finally { dispatch = null; }
  }
  // A jump materializes only its ancestry; neighbouring history follows the viewport.
  function mountFrom(id) {
    if (needsArrange) arrange();
    const chain = [];
    for (let block = store.get(id); block; block = parentOf(block)) chain.push(block);
    for (const block of chain.reverse()) {
      mount(block, true);
      if (block.id !== id) expand(block.id, true);
    }
  }
  function beginOpen() {
    resetFollowSpace();
    if (!opening) {
      opening = true;
      openStart = performance.now();
      root.classList.add('view-opening');
    }
    openReady = false;
    following = true;
  }
  // Reveal once the bottom has held still for a couple of frames.
  function settleOpen() {
    if (!opening || !openReady || openFrame || !visible()) return;
    let last = -1, still = 0, frames = 0;
    const step = () => {
      openFrame = 0;
      if (!opening || !openReady || !visible()) return;
      following = true;
      stickToBottom();
      const height = root.scrollHeight;
      still = height === last ? still + 1 : 0;
      last = height;
      if (++frames < 30 && still < 2) { openFrame = requestAnimationFrame(step); return; }
      opening = false;
      stickToBottom();
      queueView();
      root.classList.remove('view-opening');
      let mounted = 0;
      for (const block of store.values()) if (block.el) mounted++;
      log('view.open', { blocks: store.size, mounted, dur_ms: Math.round(performance.now() - openStart) });
    };
    step();
  }
  function flush() {
    if (!fontsReady || document.hidden) return;
    if (resizeContainersPending) {
      resizeContainersPending = false;
      resize.observe(column);
      resize.observe(root);
    }
    const batchStart = performance.now();
    const start = replayStarted || batchStart;
    flushTheme();
    layout();
    if (!visible()) return;
    sync(replayPending);
    stickToBottom();
    if (opening) { openReady = true; settleOpen(); }
    changed();
    trimSpace();
    historyBatch = false;
    if (replayPending) log('view.replay', { status: 'ok', blocks: store.size, dur_ms: Math.round(performance.now() - start) });
    replayPending = false;
    replayStarted = 0;
    longestBatch = Math.max(longestBatch, performance.now() - batchStart);
    queuePerf();
  }
  // A rebuild (compaction, display change) re-sends the whole chat after a reset marked `swap`.
  // Its events are held until the end marker and applied in one step like a reattach replay, so
  // the page never clears, jumps or pulls the reader down. A lost end marker falls back after
  // SWAP_MAX_MS to the old clear-and-refill, since a partial chat can't stand in for the whole.
  const SWAP_END = 'view:swap-end', SWAP_MAX_MS = 10000;
  let swap = null;
  function holdSwap(msg) {
    if (msg.replay) {
      if (swap) { clearTimeout(swap.timer); log('view.swap', { status: 'replaced', events: swap.events.length }); swap = null; }
      return false;
    }
    let events = msg.events;
    // A newer reset replaces a rebuild still being held. A plain reset ends the hold, a swap reset starts a new one.
    if (swap) {
      const again = events.findIndex((ev) => ev.op === 'reset');
      if (again >= 0) {
        clearTimeout(swap.timer);
        log('view.swap', { status: 'superseded', events: swap.events.length });
        swap = null;
        if (!events[again].swap) { receive({ ...msg, events: events.slice(again) }); return true; }
        events = events.slice(again);
      }
    }
    if (!swap) {
      const at = events.findIndex((ev) => ev.op === 'reset' && ev.swap);
      if (at < 0) return false;
      if (at > 0) receive({ ...msg, events: events.slice(0, at) });
      swap = { reset: events[at], events: [], started: performance.now(), timer: setTimeout(() => endSwap('timeout'), SWAP_MAX_MS) };
      events = events.slice(at + 1);
    }
    const end = events.findIndex((ev) => ev.op === 'remove' && ev.id === SWAP_END);
    swap.events.push(...(end < 0 ? events : events.slice(0, end)));
    if (end < 0) return true;
    endSwap('ok');
    if (end + 1 < events.length) receive({ ...msg, events: events.slice(end + 1) });
    return true;
  }
  function endSwap(status) {
    const held = swap;
    swap = null;
    clearTimeout(held.timer);
    log('view.swap', { status, events: held.events.length, dur_ms: Math.round(performance.now() - held.started) });
    if (status === 'ok') receive({ events: held.events, replay: true, swap: true });
    else receive({ events: [{ ...held.reset, swap: false }, ...held.events] });
  }
  function receive(msg) {
    if (!Array.isArray(msg?.events)) { error('view.events', 'missing events'); return; }
    if (!msg.swap && holdSwap(msg)) return;
    const batchStart = performance.now();
    const first = !enabled;
    enabled = true;
    batchInstant = !!msg.replay || first || document.hidden || !fontsReady;
    if ((msg.replay && !msg.swap) || first) beginOpen();
    // Removals and resets arrive with compaction rebuilds: the room they free is not new space.
    for (const ev of msg.events) {
      if (ev.op !== 'remove' && ev.op !== 'reset') continue;
      historyBatch = true;
      noteSpace(ev.op);
      break;
    }
    if (msg.swap) historyBatch = true;
    if (msg.replay) noteSpace(msg.swap ? 'swap' : 'replay');
    if (msg.replay) {
      replayPending = true;
      replayStarted = performance.now();
      const ids = new Set(msg.events.filter((ev) => ev.op !== 'reset' && ev.type !== 'theme').map((ev) => ev.id));
      for (const block of store.values()) if (!ids.has(block.id)) removeBlock(block);
    }
    nowSince = performance.now();
    for (const ev of msg.events) {
      try {
        if (ev.v !== 1 || ev.sid !== cfg.session) throw new Error('wrong event version or session');
        reduce(ev);
        eventsApplied++;
        perfDirty = true;
        if (debug()) log('view.event', { id: ev.id, op: ev.op, kind: ev.kind, seq: ev.seq });
      } catch (err) { error('view.events', err, { block: ev?.id }); }
    }
    if (msg.replay) {
      const next = msg.events.map((ev) => store.get(ev.id)).filter(Boolean);
      store.clear();
      for (const block of next) store.set(block.id, block);
      needsArrange = true;
    }
    if (first) log('view.attach', { status: 'ok', blocks: store.size });
    if (msg.events.some((ev) => ev.type !== 'theme')) queueView();
    longestBatch = Math.max(longestBatch, performance.now() - batchStart);
    queuePerf();
    updateNow();
  }
  function layout() {
    if (themePending) flushTheme();
    const shown = enabled && fontsReady && chromeRows > 0 && term.buffer.active.type === 'normal';
    root.hidden = !shown;
    root.classList.toggle('view-hidden', !shown || document.hidden);
    document.body.classList.toggle('r7-view', shown);
    if (!shown) {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      stopPerf();
      // Without the page, the harness uses the terminal's columns.
      if (widthKey) { widthKey = ''; layoutKey = ''; savedValues.removeItem(`r7.pageWidth.${cfg.session}`); }
      return;
    }
    const rect = screenEl.getBoundingClientRect();
    const box = currentBox();
    // The page ends above the chrome: whichever is taller, the chrome's rows or the live box
    // with everything under it, so a growing box or a late chrome mark never covers text.
    let rows = Math.min(term.rows, chromeRows);
    if (box) rows = Math.max(rows, term.rows - box.top);
    // Keep one blank row above the title without covering queued messages.
    window.r7TitleTrim = rows === Math.min(term.rows, chromeRows) ? Math.max(0, blankChromeRows() - 1) * rowHeight() : 0;
    const bottom = Math.ceil(Math.max(0, window.innerHeight - rect.bottom) + rows * rowHeight() + (window.r7Zoom?.titleExtra || 0)) - window.r7TitleTrim;
    // Centre the page with half the input box's side margins.
    const cw = cellWidth();
    // Both sides take the left margin, so the page is centred in the window even when the box's
    // right edge sits a column or two short.
    const boxLeft = box ? rect.left + box.left * cw : 0;
    const left = box ? Math.max(0, Math.round(boxLeft * PAGE_MARGIN)) : 0;
    const width = box ? Math.round(window.innerWidth - 2 * left) : 0;
    // The page's own zoom (Ctrl+wheel over the page; renderer.js r7Zoom).
    const zoom = window.r7Zoom?.get('page') || 1;
    const key = `${bottom}|${dockHeight}|${left}|${width}|${zoom}`;
    if (key !== layoutKey) {
      layoutKey = key;
      // The page stops at the dock's top edge, so nothing scrolls behind the dock's cards or pills.
      const dockMoved = dockHeight !== lastDock;
      lastDock = dockHeight;
      const by = dockMoved ? 'dock' : box && term.rows - box.top > chromeRows ? 'box' : 'chrome';
      fitBottom(bottom + dockHeight, by, !!window.r7View && window.r7View.zoom !== zoom);
      root.style.setProperty('--col-left', `${left}px`);
      root.style.setProperty('--col-width', box ? `${width}px` : '100%');
      root.style.setProperty('--view-zoom', zoom);
      const chars = Math.max(1, Math.floor(((width || window.innerWidth) / zoom - 16) / ctx.cellWidth));
      if (chars !== columnChars) {
        columnChars = chars;
        for (const slot of column.querySelectorAll('[data-placeholder-id]')) {
          const block = store.get(slot.dataset.placeholderId);
          if (block) placeholder(block);
        }
        spacersResize = true;
      }
      window.dispatchEvent(new Event('r7-view-layout'));
      publishWidth();
      if (window.r7View && window.r7View.zoom !== zoom) {
        window.r7View.zoom = zoom;
      }
      stickToBottom();
      perfDirty = true;
      queueView();
    }
    settleOpen();
    schedule();
    queuePerf();
  }
  // Publish reply and title character widths for the harness.
  function publishWidth() {
    if (!cfg.session) return;
    const probe = document.createElement('div');
    probe.className = 'reply view-block';
    probe.style.cssText = 'visibility:hidden;height:0;padding-top:0;padding-bottom:0;overflow:hidden';
    // Unwrapped spans: a wrapped one would measure the column, not the text.
    // Rects throughout: they include the page zoom, which clientWidth leaves out.
    const line = document.createElement('div');
    const text = document.createElement('span');
    text.style.whiteSpace = 'nowrap';
    text.textContent = 'x'.repeat(100);
    line.appendChild(text);
    const title = document.createElement('h2');
    title.className = 'reply-heading reply-title';
    title.innerHTML = '<span style="white-space:nowrap"></span>';
    title.firstChild.textContent = 'x'.repeat(100);
    probe.append(line, title);
    column.appendChild(probe);
    const inner = line.getBoundingClientRect().width;
    const charW = text.getBoundingClientRect().width / 100;
    const titleW = title.firstChild.getBoundingClientRect().width / 100;
    probe.remove();
    if (!(inner > 0 && charW > 0 && titleW > 0)) return;
    const value = JSON.stringify({ chars: Math.floor(inner / charW), title: Math.floor(inner / titleW) });
    if (value === widthKey) return;
    widthKey = value;
    savedValues.setItem(`r7.pageWidth.${cfg.session}`, value);
  }
  // Show elapsed time while the harness works between active page blocks.
  function updateNow() {
    clearTimeout(nowTimer);
    nowTimer = 0;
    const busy = window.r7Busy && enabled && visible();
    const reserved = !!(window.r7Busy && enabled);
    let resized = nowEl.classList.contains('view-now-reserved') !== reserved;
    nowEl.classList.toggle('view-now-reserved', reserved);
    const quiet = busy && !reveals.size && !column.querySelector('.c-running:not(.c-think)');
    const idle = performance.now() - nowSince;
    const show = quiet && idle > 700;
    if (show) {
      const s = Math.floor(idle / 1000);
      nowClock.textContent = s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
    }
    if (nowEl.hidden === show) {
      nowEl.hidden = !show;
      resized = true;
    }
    if (resized) stickToBottom();
    if (busy) nowTimer = setTimeout(updateNow, show ? 1000 - idle % 1000 : 750);
  }
  window.addEventListener('r7-busy', () => {
    requestSpaceTrim(window.r7Busy ? 'start' : 'end');
    updateNow();
  });
  document.addEventListener('visibilitychange', updateNow);

  // Blank rows at the top of the reserved chrome, read from the screen.
  function blankChromeRows() {
    const b = term.buffer.active;
    const first = term.rows - Math.min(term.rows, chromeRows);
    let n = 0;
    for (let y = first; y < term.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      if (!line || line.translateToString(true).trim()) break;
      n++;
    }
    return n;
  }
  // Keep the input box's last position through brief redraws.
  function currentBox() {
    const buf = term.buffer.active;
    if (buf.viewportY !== buf.baseY) return lastBox;
    const box = findBox();
    if (box) { lastBox = box; boxMiss = 0; return box; }
    if (++boxMiss < 3) return lastBox;
    lastBox = null;
    return null;
  }
  function expand(id, on) {
    const block = store.get(id), kind = block && kinds.get(block.ev.kind);
    if (!block || !kind?.expand) return false;
    contentChanged = true;
    block.historyLayout = false;
    noteSpace(on ? 'open' : 'close', id);
    try {
      if (block.el) kind.expand(block.el, block.ev, on);
      block.expanded = !!on;
      if (!block.el && block.placeholder) placeholder(block);
      if (!block.el) spacersResize = true;
      queueView();
      perfDirty = true;
      queuePerf();
      return true;
    }
    catch (err) { error('view.expand', err, { block: id }); return false; }
  }

  function updateTheme() {
    if (themePending) return;
    themePending = true;
    queueMicrotask(() => { if (themePending) flushTheme(); });
  }
  function flushTheme() {
    themePending = false;
    const p = colors.palette;
    const base = {
      bg: colors.bg, text: colors.fg, accent: colors.cursor || p[5],
      subtle: p[0], dim: p[8], muted: p[7], bright: p[15], outer: p[14],
      link: p[13], gold: p[3], success: p[2], error: p[9], warn: p[11], question: p[11], folder: p[11],
    };
    const activeRoles = previewRoles || liveRoles;
    Object.assign(base, activeRoles || {});
    // The stream's bg aliases statusLineBg, not the terminal's OSC 11 background.
    base.bg = colors.bg;
    base.error = activeRoles?.error || p[9];
    base.warn = activeRoles?.warning || activeRoles?.warn || p[11];
    base.success = activeRoles?.success || p[2];
    base.panel ||= `color-mix(in srgb, ${base.bg} 65%, ${base.subtle})`;
    base.user ||= base.panel;
    let changed = false;
    function set(name, value) {
      value = String(value ?? '');
      if (themeValues.get(name) === value) return;
      themeValues.set(name, value);
      root.style.setProperty(name, value);
      changed = true;
    }
    for (const name of roles) set(`--${name}`, base[name]);

    if (changed) { perfDirty = true; queuePerf(); }
  }
  colorListeners.push(updateTheme);
  updateTheme();

  window.r7View = {
    root, registerKind(kind, handler) {
      if (kinds.has(kind)) throw new Error(`duplicate view kind: ${kind}`);
      if (typeof handler.create !== 'function' || typeof handler.patch !== 'function') throw new Error(`invalid view kind: ${kind}`);
      kinds.set(kind, handler);
    },
    blocks, records, flushTheme, setFold,
    previewTheme(roles) {
      previewRoles = roles;
      confirmedRoles = false;
      updateTheme();
    },
    confirmTheme(roles) {
      // The cached roles are authoritative too; keep them until their stream event arrives.
      previewRoles = roles && !sameRoles(roles, liveRoles) ? roles : null;
      confirmedRoles = !!previewRoles;
      if (roles) liveRoles = { ...roles };
      updateTheme();
    },
    retainAll(reason, on) {
      if (on) {
        if (keepAll.has(reason)) return;
        keepAll.add(reason);
        flushTheme();
        sync(true);
        changed();
      } else if (keepAll.delete(reason)) queueView();
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    scrollToBlock(id, options = {}) {
      const block = store.get(id);
      if (!block) return false;
      jumpTarget = block;
      jumpOptions = options;
      readingAnchor = null;
      if (!block.el) {
        setFollowing(false, 'jump');
        mountFrom(id);
      }
      if (!block.el) return false;
      for (let parent = store.get(block.ev.parent), seen = new Set(); parent && !seen.has(parent.id); parent = store.get(parent.ev.parent)) {
        seen.add(parent.id);
        expand(parent.id, true);
      }
      setFollowing(false, 'jump');
      jumpTarget = block;
      alignJump();
      return true;
    },
    expand, typeReveal,
    get jumping() { return !!jumpTarget; },
    get following() { return following; },
    get space() { return { contentHeight, vacancy: followSpace, natural: naturalHeight(), virtualShift }; },
    scrollDirection(dy) { readingDown = dy > 0; if (!following) rememberAnchor(); },
    // Something outside the view (fold.js) just held the reader's place itself: take the page as it
    // is now as the place to hold, or the next resize corrects for the same move a second time.
    rememberPlace() { rememberAnchor(); },
    blockTop,
    get active() { return enabled && chromeRows > 0; },
    // The reader scrolled up on purpose: stop autoscroll until the page is back at the bottom.
    release(by = 'keys') { jumpTarget = null; setFollowing(false, by); },
    // Back to the bottom and follow new output.
    follow(by = 'keys') { jumpTarget = null; setFollowing(true, by); stickToBottom(); queueView(); },
  };

  root.addEventListener('scroll', () => {
    // Wheel/key owners resume following only when their downward gesture ends.
    // Layout corrections also emit scroll events and are not reader intent.
    rememberAnchor();
    queueView();
  }, { passive: true });
  root.addEventListener('scrollend', () => {
    alignJump();
    queueView();
  });
  const resize = new ResizeObserver((entries) => {
    const anchor = readingAnchor;
    let resized = false;
    for (const entry of entries) {
      const block = store.get(entry.target.dataset.viewId);
      if (block) {
        if (!resized) noteSpace('resize', block.id);
        measure(block);
        resized = true;
      }
    }
    restoreAnchor(anchor);
    // Hold changed cards before paint, then rearm container observation
    // next frame so the extent write cannot feed this resize delivery.
    if (following && resized) {
      resize.unobserve(column);
      resize.unobserve(root);
      resizeContainersPending = true;
      stickToBottom();
    }
    noteContent();
    if (!following) rememberAnchor();
    queueView();
  });
  resize.observe(column);
  resize.observe(root);
  // An image finishing its load grows its block above the reader's place.
  root.addEventListener('load', () => { imageAt = performance.now(); }, true);
  window.addEventListener('r7-view-events', (e) => receive(e.detail));
  window.addEventListener('r7-clear', () => {
    clear();
    retained.clear();
    animated.clear();
    folds.clear();
    foldById.clear();
    keepAll.clear();
    if (openFrame) cancelAnimationFrame(openFrame);
    openFrame = 0;
    opening = openReady = false;
    root.classList.remove('view-opening');
    queueView();
  });
  window.addEventListener('r7-view-chrome', layout);
  window.addEventListener('r7-zoom', (e) => { if (e.detail.kind === 'page') layout(); });
  window.addEventListener('r7-dock-layout', (e) => {
    if (Number.isFinite(e.detail?.height)) dockHeight = Math.max(0, e.detail.height);
    layout();
  });
  term.onRender(layout);
  // Keep the terminal's title rows out of page selections.
  function chromeTop() {
    const box = currentBox();
    return box ? box.top : term.rows - Math.min(term.rows, chromeRows);
  }
  screenEl.addEventListener('mousedown', (e) => {
    if (!window.r7View?.active || root.hidden || e.button !== 0) return;
    const rect = screenEl.getBoundingClientRect();
    const row = Math.floor((e.clientY - rect.top) / rowHeight());
    if (row < term.rows - Math.min(term.rows, chromeRows) || row >= chromeTop()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    term.clearSelection();
  }, true);
  term.onSelectionChange(() => {
    if (!window.r7View?.active || root.hidden || !term.hasSelection()) return;
    const p = term.getSelectionPosition();
    const b = term.buffer.active;
    if (p && p.start.y - b.viewportY < chromeTop()) term.clearSelection();
  });
  // A left click on the page clears a terminal selection left from before.
  root.addEventListener('pointerdown', (e) => { if (e.button === 0 && term.hasSelection()) term.clearSelection(); });
  term.buffer.onBufferChange(layout);
  window.addEventListener('resize', layout);
  document.addEventListener('visibilitychange', () => {
    root.classList.toggle('view-hidden', document.hidden);
    if (document.hidden) {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (viewFrame) { cancelAnimationFrame(viewFrame); viewFrame = 0; }
      stopPerf();
      return;
    }
    flush();
    schedule();
  });
  root.classList.toggle('view-hidden', document.hidden);
  root.style.fontFamily = term.options.fontFamily;
  document.fonts.load(`15px ${term.options.fontFamily}`).then(() => {
    if (!document.fonts.check(`15px ${term.options.fontFamily}`)) throw new Error('view font is not available');
    fontsReady = true;
    flush();
  }).catch((err) => error('view.fonts', err));
})();
