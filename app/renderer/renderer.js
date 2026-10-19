'use strict';
// One window = one view of one daemon session. The window keeps no state of its
// own: every (re)connect starts from the daemon's snapshot.

const cfg = JSON.parse(new URLSearchParams(location.search).get('cfg'));
const statusEl = document.getElementById('status');
document.documentElement.style.setProperty('--bg', cfg.theme.background || '#000');
document.documentElement.style.setProperty('--pad', `${cfg.padding}px`);
document.title = cfg.title;

// Font sizes are points, like Windows Terminal, so a template can copy its profile.
let fontPoints = cfg.font.size;
const pointsToPx = (pt) => pt * 96 / 72;

function seeThroughSelection(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) return {};
  return { selectionBackground: `${color}88`, selectionInactiveBackground: `${color}55` };
}

const term = new Terminal({
  fontFamily: `"${cfg.font.family}", "Cascadia Mono", Consolas, monospace`,
  fontSize: pointsToPx(fontPoints),
  // The cursor is drawn by the page so it can glide (see "gliding cursor");
  // xterm's own is an invisible bar.
  // The selection is see-through, so colored text keeps its color under it.
  theme: { ...cfg.theme, cursor: 'rgba(0,0,0,0)', ...seeThroughSelection(cfg.theme.selectionBackground) },
  scrollback: cfg.scrollback,
  smoothScrollDuration: 0,
  cursorBlink: false,
  cursorStyle: 'bar',
  cursorWidth: 1,
  cursorInactiveStyle: 'none',
  allowProposedApi: true,
  drawBoldTextInBrightColors: false,
  minimumContrastRatio: 1,
  // OSC 8 links open on a plain click.
  linkHandler: { activate: (_e, uri) => r7.openExternal(uri) },
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
const unicode = new Unicode11Addon.Unicode11Addon();
term.loadAddon(unicode);
term.unicode.activeVersion = '11';

// Web links and file paths open on a plain click.
const hoveredLinks = new Set();
// Titled links show their address beside the pointer.
const linkTip = document.createElement('div');
linkTip.id = 'link-tip';
document.body.appendChild(linkTip);
let pointer = { x: 0, y: 0 };
function placeTip() {
  const r = linkTip.getBoundingClientRect();
  const x = Math.min(pointer.x + 14, innerWidth - r.width - 6);
  const y = pointer.y + 20 + r.height > innerHeight ? pointer.y - r.height - 10 : pointer.y + 20;
  linkTip.style.transform = `translate(${Math.max(6, x)}px, ${Math.max(6, y)}px)`;
}
function showLinks() {
  let tip = '';
  for (const link of hoveredLinks) {
    link.decorations.underline = true;
    link.decorations.pointerCursor = true;
    if (link.tip) tip = link.tip;
  }
  const on = !!tip;
  if (on && linkTip.textContent !== tip) linkTip.textContent = tip;
  linkTip.classList.toggle('on', on);
  if (on) placeTip();
}
function linkText(range) {
  let text = '';
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = term.buffer.active.getLine(y - 1);
    if (!line) break;
    const from = y === range.start.y ? range.start.x - 1 : 0;
    const to = y === range.end.y ? range.end.x : term.cols;
    text += line.translateToString(false, from, to);
  }
  return text.trim();
}
function decorateLinks(provider, withTip = false) {
  return {
    provideLinks(y, callback) {
      provider.provideLinks(y, (links) => callback(links && links.map((link) => {
        const gated = {
          ...link,
          decorations: { underline: true, pointerCursor: true },
          tip: withTip && linkText(link.range) !== link.text ? link.text : '',
          activate: (e, text) => link.activate(e, text),
          hover: (e, text) => { link.hover?.(e, text); hoveredLinks.add(gated); queueMicrotask(showLinks); },
          leave: (e, text) => { link.leave?.(e, text); hoveredLinks.delete(gated); showLinks(); },
        };
        return gated;
      })));
    },
  };
}
window.addEventListener('mousemove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (linkTip.classList.contains('on')) placeTip();
}, true);
// xterm doesn't always send `leave` when a hovered link scrolls away; drop the tip then.
function dropTip() {
  for (const link of hoveredLinks) if (link.tip) hoveredLinks.delete(link);
  linkTip.classList.remove('on');
}
term.onScroll(dropTip);
window.addEventListener('wheel', dropTip, true);

const registerLinks = term.registerLinkProvider.bind(term);
term.registerLinkProvider = (provider) => registerLinks(decorateLinks(provider));
term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => r7.openExternal(url)));
term.registerLinkProvider = registerLinks;
const search = new SearchAddon.SearchAddon();
term.loadAddon(search);
const images = new ImageAddon.ImageAddon();
term.loadAddon(images);
term.open(document.getElementById('term'));
// Add address tips to xterm's OSC 8 provider.
{
  const providers = term._core._linkProviderService?.linkProviders;
  if (providers?.[0] && providers[0]._oscLinkService) providers[0] = decorateLinks(providers[0], true);
  else r7.log('warn', 'links.osc-unwrapped', { session: cfg.session });
}

let renderer = 'dom';
function loadWebgl() {
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => {
      r7.log('warn', 'webgl.lost', { session: cfg.session });
      webgl.dispose();
      renderer = 'dom';
      setTimeout(loadWebgl, 2000);
    });
    term.loadAddon(webgl);
    renderer = 'webgl';
  } catch (e) {
    r7.log('warn', 'webgl.unavailable', { session: cfg.session, error: String(e) });
  }
}
if (cfg.gpu) loadWebgl();

// Rows stand on the bottom edge: the part of a row that won't fit goes above the first
// row instead of under the last, so the input box sits at the same height in every
// window, with or without the top panel. BOTTOM_GAP is the room left under the last row.
const BOTTOM_GAP = 3;
const termEl = document.getElementById('term');
function fitRows() {
  const cellH = term._core?._renderService?.dimensions?.css?.cell?.height;
  if (cellH) {
    const room = window.innerHeight - 2 * (cfg.padding ?? 18) - BOTTOM_GAP;
    const spare = Math.max(0, room - Math.floor(room / cellH) * cellH);
    const dpr = window.devicePixelRatio || 1;
    termEl.style.setProperty('--r7-spare', `${Math.floor(spare * dpr) / dpr}px`);
  }
  fit.fit();
  // The grid is whole columns, so some width is always left over; split it between both sides
  // so the input box has the same margin left and right. Moving both edges keeps the width, so the fit holds.
  const cellW = term._core?._renderService?.dimensions?.css?.cell?.width;
  if (cellW) {
    const dpr = window.devicePixelRatio || 1;
    const spareX = Math.max(0, termEl.clientWidth - term.cols * cellW) / 2;
    termEl.style.setProperty('--r7-spare-x', `${Math.floor(spareX * dpr) / dpr}px`);
  }
}
fitRows();

// ---- connection ---------------------------------------------------------------

const enc = new TextEncoder();
let ws = null;
let retryMs = 250;
let exited = false;
let snapshotHeader = null;
let chromeRows = null;

term.parser.registerOscHandler(7321, (data) => {
  if (data === 'clear') {
    resetScroll();
    followBottom = true;
    term.clearSelection();
    term.scrollToBottom();
    hoveredLinks.clear();
    dropTip();
    window.dispatchEvent(new Event('r7-clear'));
    term.refresh(0, term.rows - 1);
    r7.log('info', 'view.clear', { session: cfg.session });
    return true;
  }
  if (!data.startsWith('chrome;')) return false;
  const value = data.slice(7);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    r7.log('error', 'view.chrome', { session: cfg.session, error: 'invalid row count' });
    return true;
  }
  chromeRows = Math.min(500, Number(value));
  window.dispatchEvent(new CustomEvent('r7-view-chrome', { detail: { rows: chromeRows } }));
  return true;
});

function status(text) {
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
}

function connect() {
  const url = `ws://127.0.0.1:${cfg.port}/ws?session=${encodeURIComponent(cfg.session)}&token=${cfg.token}&cols=${term.cols}&rows=${term.rows}`;
  const sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      if (snapshotHeader) { applySnapshot(snapshotHeader, new Uint8Array(ev.data)); snapshotHeader = null; return; }
      writeOutput(new Uint8Array(ev.data));
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      snapshotHeader = msg;
    } else if (msg.type === 'view') {
      window.dispatchEvent(new CustomEvent('r7-view-events', { detail: msg }));
    } else if (msg.type === 'title') {
      setTitle(msg.title);
    } else if (msg.type === 'exit') {
      exited = true;
      showExit(msg.code);
    }
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    if (ev.code === 4001 || ev.code === 4004) { r7.closeWindow(); return; }
    status('reconnecting…');
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 2000);
  };
}

function applySnapshot(msg, data) {
  retryMs = 250;
  status('');
  held = [];
  heldBytes = 0;
  term.reset();
  chromeRows = null;
  resetColors();
  resetScroll();
  if (msg.cols !== term.cols || msg.rows !== term.rows) sendJson({ type: 'resize', cols: term.cols, rows: term.rows });
  followBottom = true;
  writeOutput(data);
  setTitle(msg.title);
  exited = !msg.alive && msg.exitCode != null;
  if (exited) showExit(msg.exitCode);
  // A snapshot keeps text and colors but not r7-Harness's title marks or pictures. It
  // reprints its whole transcript on a width change, so one narrow-and-back brings them back.
  term.write('', () => {
    if (exited || !harness.on || window.r7View?.active) return;
    sendJson({ type: 'resize', cols: term.cols - 1, rows: term.rows });
    setTimeout(() => sendJson({ type: 'resize', cols: term.cols, rows: term.rows }), 150);
  });
  for (const fn of snapshotListeners) fn(msg, data);
  r7.log('info', 'attach', { session: cfg.session, bytes: data.length, renderer });
}
const snapshotListeners = [];

// Output keeps the view at the bottom unless you scrolled up. xterm alone can
// lose the bottom when a program clears its scrollback and reprints everything,
// which some agents do on every resize. Leaving the bottom is logged (`scroll.leave`
// with what did it); getting pulled off it any other way is put back after the
// next frame and logged as `scroll.rejoin`.
// Keep launch pace and model chips in the main process across browser profiles.
const savedValues = r7.store || localStorage;

let followBottom = true;
function leaveBottom(why) {
  if (!followBottom) return;
  followBottom = false;
  r7.log('info', 'scroll.leave', { session: cfg.session, why });
}
function writeOutput(data) {
  // Theme effects may handle a palette chunk, but submit its bytes immediately.
  if (window.r7ThemeFx?.take(data)) return;
  // Held output still waiting to be written keeps new output behind it, in order.
  if (document.hidden || heldBytes) { hold(data); if (document.hidden) parseHidden(); return; }
  term.write(data, keepBottom);
}
function keepBottom() {
  const b = term.buffer.active;
  if (followBottom && !scroll.frame && b.viewportY !== b.baseY) term.scrollToBottom();
}

// A minimized or covered window holds its output. Chromium slows a hidden window's timers
// to one a second (one a minute after 5 minutes), and xterm parses output on timers, so
// it fell minutes behind and replayed them on restore. So a hidden window parses what it
// held itself, at most every HIDDEN_PARSE_MS as output arrives (`parseHidden`, run from
// the socket's message, which isn't throttled), and draws nothing until it shows: showing
// it then only parses the last moment's output. Waiting until the show instead took
// 0.7-1.2s for 1-2MB after a few minutes of an agent working, with the old screen up.
// Whatever is still held on show is written then; `catchingUp` tells fade.js to skip
// fading and gliding it, and the first frame after a show (everything that changed while
// hidden). Past HOLD_MAX the window takes a fresh copy of the screen instead. A large
// catch-up blocks the page, so a window revealed by Alt+CapsLock plays its pulse (glow.js)
// first and catches up when the pulse ends; parsing at once ate the pulse's first frames.
const HOLD_MAX = 4 << 20;
const HIDDEN_PARSE_MS = 300;
const QUICK_CATCHUP = 32 << 10;
let hiddenParsedAt = 0;
let hiddenParseTimer = 0;
let shownQuiet = false;
function parseHidden() {
  const now = performance.now();
  if (heldBytes > HOLD_MAX || !document.hidden || !heldBytes) return;
  // The rest of a burst is parsed by a timer (about a second late while hidden: a single
  // timer, not a chain, so it never drops to one a minute).
  // So does output that arrives while xterm's own queue is busy (a picture decoding).
  const queue = term._core?._writeBuffer;
  if (!queue?.handleUserInput) return;
  if (now - hiddenParsedAt < HIDDEN_PARSE_MS || queue._writeBuffer.length) {
    if (!hiddenParseTimer) hiddenParseTimer = setTimeout(() => { hiddenParseTimer = 0; parseHidden(); }, HIDDEN_PARSE_MS);
    return;
  }
  hiddenParsedAt = now;
  const all = takeHeld();
  // Marks the write as typed input, which xterm parses at once instead of on a timer.
  queue.handleUserInput();
  term.write(all, keepBottom);
}
function takeHeld() {
  const all = new Uint8Array(heldBytes);
  let at = 0;
  for (const chunk of held) { all.set(chunk, at); at += chunk.length; }
  held = [];
  heldBytes = 0;
  return all;
}
let held = [];
let heldBytes = 0;
let catchingUp = false;
function hold(data) {
  if (heldBytes > HOLD_MAX) return;
  held.push(data);
  heldBytes += data.length;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // A scroll animation can't run while hidden; one still under way jumps to its end.
  if (scroll.frame) { cancelAnimationFrame(scroll.frame); scroll.frame = 0; placeScroll(scroll.target); keepBottom(); }
  // The first frame after a show is quiet; with nothing new to draw there is none.
  shownQuiet = true;
  const quietOff = term.onRender(() => { quietOff.dispose(); setTimeout(() => { shownQuiet = false; }); });
  setTimeout(() => { quietOff.dispose(); shownQuiet = false; }, 200);
  if (!heldBytes) return;
  const shown = performance.now();
  if (heldBytes <= QUICK_CATCHUP) return catchUp(shown);
  requestAnimationFrame(() => catchUp(shown));
});
function catchUp(shown) {
  if (document.hidden || !heldBytes) return;
  const t0 = performance.now();
  const bytes = heldBytes;
  if (bytes > HOLD_MAX) {
    held = [];
    heldBytes = 0;
    r7.log('info', 'catchup', { session: cfg.session, bytes, fresh: true });
    ws?.close();
    return;
  }
  const all = takeHeld();
  catchingUp = true;
  term.write(all, () => {
    catchingUp = false;
    keepBottom();
    r7.log('info', 'catchup', { session: cfg.session, bytes, ms: Math.round(performance.now() - t0), waitMs: Math.round(t0 - shown) });
  });
}

// Frames that block this window's page for 250ms+ (log `frame.long`), at most one
// line per 2s. The browser reports them itself, so it costs nothing while all is smooth.
(() => {
  let last = 0;
  let skipped = 0;
  try {
    new PerformanceObserver((list) => {
      for (const f of list.getEntries()) {
        if (f.duration < 250) continue;
        if (f.startTime - last < 2000) { skipped++; continue; }
        last = f.startTime;
        const s = [...(f.scripts || [])].sort((a, b) => b.duration - a.duration)[0];
        r7.log('warn', 'frame.long', {
          session: cfg.session, ms: Math.round(f.duration), blockingMs: Math.round(f.blockingDuration || 0),
          catchingUp, hidden: document.hidden, skipped,
          ...(s ? { script: `${s.invoker || ''} ${(s.sourceURL || '').split('/').pop()}:${s.sourceCharPosition ?? ''}`.trim(), scriptMs: Math.round(s.duration) } : {}),
        });
        skipped = 0;
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch (e) {
    r7.log('warn', 'frame.watch_error', { session: cfg.session, error: e.message });
  }
})();

function sendJson(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// input.js looks at typing first: type-ahead while a program starts, and replacing a
// selection in its input box. A hook that returns true has handled the input.
const editHooks = [];

function sendInput(data) {
  if (exited) {
    if (data === '\r') { exited = false; sendJson({ type: 'restart' }); }
    return;
  }
  for (const hook of editHooks) if (hook(data)) return;
  sendRaw(data);
}

function sendRaw(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(data));
}

function setTitle(title) {
  if (!title) return;
  document.title = title;
  r7.setTitle(title);
}

function showExit(code) {
  term.write(`\r\n\x1b[2m[process exited${code != null ? ` with code ${code}` : ''} · Enter restarts · Ctrl+Shift+W closes]\x1b[0m`);
}

term.onData((data) => { followBottom = true; sendInput(data); });
term.onBinary((data) => {
  if (!ws || ws.readyState !== WebSocket.OPEN || exited) return;
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255;
  ws.send(bytes);
});

// Refit on every frame while the window is being resized, so the text follows the edge live.
let resizeFrame = 0;
function refit() {
  resizeFrame = 0;
  const before = `${term.cols}x${term.rows}`;
  fitRows();
  if (`${term.cols}x${term.rows}` === before) return;
  // A resize clears the canvas and xterm redraws on the next frame, which flashes
  // black while dragging; draw now instead (private xterm internals, guarded).
  const debouncer = term._core?._renderService?._renderDebouncer;
  if (debouncer?._animationFrame) {
    cancelAnimationFrame(debouncer._animationFrame);
    debouncer._innerRefresh();
  }
  resetScroll();
  sendResize();
}

// While dragging, the program gets at most one resize per 100ms plus the final
// size; a full-screen app redraws everything on each one.
let resizeTimer = 0, resizeSentAt = 0;
function sendResize() {
  clearTimeout(resizeTimer);
  const wait = 100 - (performance.now() - resizeSentAt);
  if (wait > 0) { resizeTimer = setTimeout(sendResize, wait); return; }
  resizeSentAt = performance.now();
  sendJson({ type: 'resize', cols: term.cols, rows: term.rows });
}
new ResizeObserver(() => { if (!resizeFrame) resizeFrame = requestAnimationFrame(refit); }).observe(document.getElementById('term'));

// ---- keys, clipboard, zoom ----------------------------------------------------

function setFontSize(size) {
  size = Math.max(6, Math.min(36, size));
  if (size === fontPoints) return;
  fontPoints = size;
  term.options.fontSize = pointsToPx(size);
  fitRows();
  sendJson({ type: 'resize', cols: term.cols, rows: term.rows });
  r7.log('info', 'font.size', { session: cfg.session, pt: size, cols: term.cols, rows: term.rows });
  r7.saveFontSize(cfg.template, size);
}

// Copy paragraphs without terminal padding or soft line breaks.
function selectedText() {
  const p = term.getSelectionPosition();
  // Alt+drag (column selection) copies the block as it looks.
  if (!p || term._core._selectionService?._activeSelectionMode === 2) return plainSelection();
  const buf = term.buffer.active;
  const boxWidth = inputBoxWidth();
  let out = '';
  let prev = null;
  for (let y = p.start.y; y <= p.end.y; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const full = line.translateToString(true);
    const piece = line.translateToString(true, y === p.start.y ? p.start.x : 0, y === p.end.y ? p.end.x : term.cols);
    if (prev === null) out = piece;
    else if (line.isWrapped) out += piece;
    else if (softBreak(prev, full, boxWidth || blockWidth(y - 1))) {
      // A long path or word cut at the edge joins back without a space.
      const cut = prev.trimEnd().length >= (boxWidth || term.cols) && /(\S*[\/\\]\S*|\S{20,})$/.test(prev.trimEnd());
      out = out.replace(/\s+$/, '') + (cut ? '' : ' ') + piece.replace(/^\s+/, '');
    }
    else out = out.replace(/[ \t]+$/, '') + '\r\n' + piece;
    prev = full;
  }
  return out.replace(/[ \t]+$/, '').replace(/(\r\n)+$/, '');
}

function plainSelection() {
  return term.getSelection().split(/\r?\n/).map((line) => line.replace(/\s+$/, '')).join('\r\n').replace(/(\r\n)+$/, '');
}

const BOX_RE = /^\s*[│╭╰▏├└┌]/;

// The last column with a character on a line, or -1.
function lastCol(line) {
  for (let x = line.length - 1; x >= 0; x--) if (line.getCell(x)?.getChars().trim()) return x;
  return -1;
}

// Measure the harness input box, including centered columns and its bottom text row.
function findBox() {
  const buf = term.buffer.active;
  if (buf.type !== 'normal' || buf.viewportY !== buf.baseY) return null;
  let bottom = -1, left = 0, right = 0;
  for (let r = term.rows - 1; r >= 0; r--) {
    const line = buf.getLine(buf.viewportY + r);
    const text = line?.translateToString(true) || '';
    if (bottom < 0) {
      const m = /^( *)╰─.*─╯$/.exec(text);
      if (!m) continue;
      bottom = r;
      left = m[1].length;
      right = lastCol(line);
    } else if (/^ *╭/.test(text)) return { top: r, bottom, left, right };
    else if (!/^ *│/.test(text)) return null;
  }
  return null;
}

// The harness wraps its text one column short of its input box's width.
function inputBoxWidth() {
  const buf = term.buffer.active;
  for (let r = term.rows - 1; r >= 0; r--) {
    const line = buf.getLine(buf.baseY + r);
    const m = /^( *)╰─.*─╯$/.exec(line?.translateToString(true) || '');
    if (m) return lastCol(line) - m[1].length;
  }
  return 0;
}

// Other programs: the widest row of the paragraph around a row is about where it wrapped.
function blockWidth(y) {
  const buf = term.buffer.active;
  const plain = (i) => {
    const line = buf.getLine(i);
    const text = line?.translateToString(true) || '';
    return line && text.trim() && !line.isWrapped && !buf.getLine(i + 1)?.isWrapped && !BOX_RE.test(text) ? text : null;
  };
  let width = 0;
  for (let i = y; i >= 0 && plain(i) !== null; i--) width = Math.max(width, plain(i).length);
  for (let i = y + 1; i < buf.length && plain(i) !== null; i++) width = Math.max(width, plain(i).length);
  return width;
}

// A row ended early only because its next word didn't fit: same paragraph, no new item.
function softBreak(prev, next, width) {
  const a = prev.replace(/\s+$/, '');
  const b = next.trim();
  if (!a.trim() || !b || width < 30) return false;
  if (BOX_RE.test(prev) || BOX_RE.test(next) || /\S {2,}\S/.test(a.trim()) || /\S {2,}\S/.test(b)) return false;
  if (/^([-*•◆✓▸○✗✦▶+−>#|`]|\d+[.?):]|[a-z]\))(\s|$)/i.test(b)) return false;
  if (next.search(/\S/) < prev.search(/\S/)) return false;
  return a.length >= width * 0.5 && a.length + 1 + b.split(/\s/)[0].length > width;
}

async function paste() {
  const text = await r7.readClipboard();
  if (text) term.paste(text);
  // No text (an image, say): pass Ctrl+V through like Windows Terminal, so the program can paste
  // the image itself. Save it first where the harness can read it directly.
  else {
    if (harness.on) {
      try { await r7.clipboardImage(cfg.session); }
      catch (error) {
        r7.log('error', 'clipboard.image', { session: cfg.session, error: String(error) });
        return;
      }
    }
    sendInput('\x16');
  }
}

// Dropping files types their paths, like Windows Terminal: WSL form, quoted when needed.
function wslPath(p) {
  const drive = /^([a-z]):\\(.*)$/i.exec(p);
  const out = drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}` : p;
  return /[^\w@%+=:,./-]/.test(out) ? `'${out.replace(/'/g, `'\\''`)}'` : out;
}
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = [...(e.dataTransfer?.files || [])].map((f) => r7.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  term.paste(paths.map(wslPath).join(' ') + ' ');
  term.focus();
});

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && !e.shiftKey && k === 'c' && term.hasSelection()) { r7.writeClipboard(selectedText()); term.clearSelection(); return false; }
  if (ctrl && e.shiftKey && k === 'c') { if (term.hasSelection()) r7.writeClipboard(selectedText()); return false; }
  // preventDefault stops the browser's own paste as well, or text lands twice.
  if (ctrl && k === 'v') { e.preventDefault(); paste(); return false; }
  if (ctrl && e.key === 'Backspace') { sendInput('\x17'); return false; }
  if (ctrl && (k === '=' || k === '+')) { zoomAt(1); return false; }
  if (ctrl && k === '-') { zoomAt(-1); return false; }
  if (ctrl && k === '0') { zoomAt(0); return false; }
  if (ctrl && e.shiftKey && k === 'n') { r7.newWindow(); return false; }
  if (ctrl && e.shiftKey && k === 'w') { r7.closeWindow(); return false; }
  if (ctrl && e.shiftKey && k === 'r') { location.reload(); return false; }
  if (ctrl && e.shiftKey && k === 'f') { openFind(); return false; }
  if (ctrl && e.shiftKey && k === 'p') { sendInput('\x1b[112;6u'); return false; }
  // Ctrl+Up answers the latest reply's next unanswered question, like clicking it (marks.js).
  if (ctrl && !e.shiftKey && e.key === 'ArrowUp' && window.r7NextQuestion?.()) { e.preventDefault(); return false; }
  // Shift+Enter sends Alt+Enter, a new line in the harness and Claude Code.
  // preventDefault stops the keypress that would still send a plain Enter.
  if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Enter') {
    e.preventDefault();
    followBottom = true;
    sendInput('\x1b\r');
    return false;
  }
  if (e.key === 'F23') { zoomAt(1); return false; }
  if (e.key === 'F24') { zoomAt(-1); return false; }
  if (e.altKey && e.shiftKey && !e.ctrlKey && k === 'd') { r7.newWindow(cfg.template); return false; }
  // With the page drawn, these scroll the page (view/keys.js); the terminal only holds the chrome.
  const paged = !!window.r7View?.active;
  if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && term.buffer.active.type === 'normal' && !paged) {
    jumpMessage(e.key === 'ArrowUp' ? -1 : 1);
    return false;
  }
  if (ctrl && e.shiftKey && term.buffer.active.type === 'normal' && !paged) {
    const rowsBy = { ArrowUp: -1, ArrowDown: 1, PageUp: -(term.rows - 1), PageDown: term.rows - 1 }[e.key];
    if (rowsBy) { scrollBy(rowsBy * rowHeight(), 'key'); return false; }
    if (e.key === 'Home') { scrollBy(-Infinity, 'key'); return false; }
    if (e.key === 'End') { scrollBy(Infinity, 'key'); return false; }
  }
  if (e.key === 'F11') { r7.toggleFullscreen(); return false; }
  return true;
});

// ---- zoom by place ---------------------------------------------------------------
// Ctrl+wheel, Ctrl+= / Ctrl+- / Ctrl+0 and the mouse zoom keys (F23/F24) zoom what the pointer is
// over: the page (transcript), the task title, or else the terminal itself (the bottom bar, its box
// and the dock, which all follow the font size). Page and title zooms are saved per template.
const zoomPointer = { x: -1, y: -1 };
window.addEventListener('pointermove', (e) => { zoomPointer.x = e.clientX; zoomPointer.y = e.clientY; }, { passive: true, capture: true });
const ZOOM_STEP = 1.1, ZOOM_MIN = 0.5, ZOOM_MAX = 3;
const zooms = {
  // Before page zoom was its own, the page followed the font; start from that look.
  page: cfg.zoom?.page || Math.round(fontPoints / (cfg.font.defaultSize || cfg.font.size) * 100) / 100,
  title: cfg.zoom?.title || 1,
};
window.r7Zoom = {
  get: (kind) => zooms[kind],
  titleExtra: 0,
  step(kind, dir) {
    const was = zooms[kind];
    const next = dir ? Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, was * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP))) * 100) / 100 : 1;
    if (next === was) return;
    zooms[kind] = next;
    r7.saveZoom(cfg.template, kind, next);
    r7.log('info', 'zoom', { session: cfg.session, target: kind, from: was, to: next });
    window.dispatchEvent(new CustomEvent('r7-zoom', { detail: { kind, value: next } }));
  },
};
function zoomTarget(x, y) {
  const over = (el) => {
    if (!el || el.hidden || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  };
  if (over(document.querySelector('#r7-task-title .r7-task-line'))) return 'title';
  if (window.r7View?.active && over(document.getElementById('view'))) return 'page';
  return 'terminal';
}
function zoomAt(dir, x = zoomPointer.x, y = zoomPointer.y) {
  const target = zoomTarget(x, y);
  if (target !== 'terminal') return window.r7Zoom.step(target, dir);
  setFontSize(dir ? fontPoints + dir : cfg.font.defaultSize || cfg.font.size);
}
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
}, { passive: false, capture: true });

// Right-click on a picture opens its menu (copy, save as, show in folder); elsewhere it
// copies the selection, or pastes when nothing is selected.
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('#view')) return;
  e.preventDefault();
  const pic = pictureAt(e.clientX, e.clientY);
  if (pic) { pic.menu(e.clientX, e.clientY); return; }
  if (term.hasSelection()) { r7.writeClipboard(selectedText()); term.clearSelection(); } else paste();
});

window.addEventListener('error', (e) => r7.log('error', 'renderer.error', { session: cfg.session, error: String(e.error?.stack || e.message) }));

// ---- colors the program sets ----------------------------------------------------
// Programs can recolor the terminal (OSC 4/10/11/12/17).
// The padding follows the background so the window stays one color, and the
// extra scroll row uses the same palette.

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const colors = {};

function resetColors() {
  colors.fg = cfg.theme.foreground || '#fff';
  colors.bg = cfg.theme.background || '#000';
  colors.palette = ANSI.map((name) => cfg.theme[name] || '#888');
  colors.cursor = cfg.theme.cursor || '';
  document.documentElement.style.setProperty('--bg', colors.bg);
  colorsChanged();
}

// Other parts (the attention glow) redraw when the colors change.
const colorListeners = [];
let colorsQueued = false;
let paletteQueued = false;
function pageColors() {
  const style = document.documentElement.style;
  if (style.getPropertyValue('--bg') !== colors.bg) style.setProperty('--bg', colors.bg);
  window.r7View?.flushTheme?.();
}
function flushPalette() {
  if (!paletteQueued) return;
  paletteQueued = false;
  // Finish page colour writes before xterm measures its newly themed glyphs.
  pageColors();
  shownSelection = selectionColor();
  setTheme(seeThroughSelection(shownSelection));
}
function applyTerminalPalette(t) {
  colors.fg = t.foreground;
  colors.bg = t.background;
  colors.cursor = t.cursorColor;
  colors.palette = ANSI.map((key) => t[key] || t[key === 'magenta' ? 'purple' : 'brightPurple']);
  paletteQueued = true;
  colorsChanged();
  flushPalette();
}
function colorsChanged() {
  if (colorsQueued) return;
  colorsQueued = true;
  queueMicrotask(() => {
    colorsQueued = false;
    pageColors();
    flushPalette();
    for (const fn of colorListeners) fn();
  });
}

function parseColor(spec) {
  spec = spec.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(spec);
  if (m) return `#${m[1]}`;
  m = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(spec);
  if (!m) return null;
  return '#' + m.slice(1).map((h) => Math.round(parseInt(h, 16) / (16 ** h.length - 1) * 255).toString(16).padStart(2, '0')).join('');
}

term.parser.registerOscHandler(4, (data) => {
  const parts = data.split(';');
  const complete = parts.length > 0 && parts.length % 2 === 0 && parts.every((part, i) =>
    i % 2 ? !!parseColor(part) : /^\d+$/.test(part) && Number(part) < 16);
  const batch = harness.on && complete;
  if (!batch) flushPalette();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const c = parseColor(parts[i + 1]);
    if (c && /^\d+$/.test(parts[i]) && Number(parts[i]) < 16) colors.palette[Number(parts[i])] = window.r7ThemeFx?.paletteColor?.(4, c, Number(parts[i])) || c;
  }
  if (batch) paletteQueued = true;
  colorsChanged();
  return batch;
});
term.parser.registerOscHandler(10, (data) => {
  const c = parseColor(data);
  const batch = harness.on && !!c;
  if (!batch) flushPalette();
  if (c) { colors.fg = window.r7ThemeFx?.paletteColor?.(10, c) || c; paletteQueued ||= batch; colorsChanged(); }
  return batch;
});
// The cursor color goes to the page's cursor; xterm's own stays invisible.
term.parser.registerOscHandler(12, (data) => {
  const c = parseColor(data);
  if (!c) return false;
  colors.cursor = window.r7ThemeFx?.paletteColor?.(12, c) || c;
  colorsChanged();
  return true;
});
term.parser.registerOscHandler(112, () => { colors.cursor = cfg.theme.cursor || ''; colorsChanged(); return true; });
term.parser.registerOscHandler(11, (data) => {
  const c = parseColor(data);
  const batch = harness.on && !!c;
  if (!batch) flushPalette();
  if (c) {
    colors.bg = window.r7ThemeFx?.paletteColor?.(11, c) || c;
    paletteQueued ||= batch;
    if (!batch) document.documentElement.style.setProperty('--bg', c);
    colorsChanged();
  }
  return batch;
});
// Resets put the template's colors back into the theme first: setTheme carries the
// program's colors into it, and xterm's own reset goes back to the theme.
term.parser.registerOscHandler(104, (data) => {
  flushPalette();
  const which = data ? data.split(';').map(Number) : null;
  ANSI.forEach((name, i) => { if (!which || which.includes(i)) colors.palette[i] = cfg.theme[name] || '#888'; });
  setTheme();
  colorsChanged();
  return false;
});
term.parser.registerOscHandler(110, () => { flushPalette(); colors.fg = cfg.theme.foreground || '#fff'; setTheme(); colorsChanged(); return false; });
term.parser.registerOscHandler(111, () => {
  flushPalette();
  colors.bg = cfg.theme.background || '#000';
  document.documentElement.style.setProperty('--bg', colors.bg);
  setTheme();
  colorsChanged();
  return false;
});
resetColors();

// Preserve the program's OSC colors while updating xterm's theme.
function setTheme(extra = {}) {
  const theme = { ...term.options.theme, ...extra, foreground: colors.fg, background: colors.bg };
  ANSI.forEach((name, i) => { theme[name] = colors.palette[i]; });
  if (Object.keys(theme).some((key) => theme[key] !== term.options.theme[key])) term.options.theme = theme;
}

// Selections take the live accent (the cursor color set by the program), not the
// template's, so they match whichever theme is on.
function selectionColor() {
  return /^#[0-9a-f]{6}$/i.test(colors.cursor) ? colors.cursor : cfg.theme.selectionBackground;
}
let shownSelection = '';
colorListeners.push(() => {
  const c = selectionColor();
  if (c === shownSelection) return;
  shownSelection = c;
  setTheme(seeThroughSelection(c));
});

// ---- smooth scrolling -----------------------------------------------------------
// xterm only scrolls by whole rows. Here the scroll position is in pixels: the
// grid shows the row under it and is shifted up by the leftover pixels, and one
// extra row drawn under the grid fills the gap that opens at the bottom edge.
// Programs that take the mouse wheel (vim, htop, full-screen apps) keep it.

const screenEl = document.querySelector('.xterm-screen');
const extraRow = document.createElement('div');
extraRow.id = 'extra-row';
extraRow.hidden = true;
screenEl.appendChild(extraRow);
const scroll = { pos: 0, target: 0, frame: 0, last: 0, row: -1, pending: null, shifted: false, extraKey: '' };

const rowHeight = () => screenEl.clientHeight / term.rows;
const cellWidth = () => screenEl.clientWidth / term.cols;

// ---- clicking a picture opens it in the viewer ---------------------------------
// Reply pictures are page elements with a file path; tool screenshots are drawn by
// the image addon, so those are saved from its canvas first. A drag still selects.
// Hovering one shows the hand cursor and a steady outline.

function windowsPath(p) {
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\//g, '\\');
  const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  return drive ? `${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}` : `\\\\wsl.localhost\\${cfg.distro}${p.replace(/\//g, '\\')}`;
}

// The picture under a point: its box on the screen element and how to open it.
const replyPictures = document.getElementsByClassName('r7-image');
function pictureAt(x, y) {
  const s = screenEl.getBoundingClientRect();
  // A live list: with no reply pictures on screen, a mouse move or render reads nothing here.
  for (const img of replyPictures.length ? document.querySelectorAll('.r7-image img') : []) {
    const r = img.getBoundingClientRect();
    if (img.dataset.path && r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return {
        box: { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height, round: 10 },
        open: () => {
          r7.log('info', 'picture.open', { session: cfg.session, path: img.dataset.path });
          r7.openPath(windowsPath(img.dataset.path));
        },
        menu: (mx, my) => r7.pictureMenu({ path: windowsPath(img.dataset.path) }, mx, my),
      };
    }
  }
  if (x < s.left || y < s.top) return null;
  const col = Math.floor((x - s.left) / cellWidth());
  const row = Math.floor((y - s.top) / rowHeight()) + term.buffer.active.viewportY;
  const box = drawnPictureBox(col, row);
  if (!box) return null;
  return {
    box,
    open: () => {
      const canvas = images.getImageAtBufferCell(col, row);
      if (!canvas) return;
      r7.log('info', 'picture.open', { session: cfg.session, drawn: `${canvas.width}x${canvas.height}` });
      r7.openImage(canvas.toDataURL('image/png'));
    },
    menu: (mx, my) => {
      const canvas = images.getImageAtBufferCell(col, row);
      if (canvas) r7.pictureMenu({ dataUrl: canvas.toDataURL('image/png') }, mx, my);
    },
  };
}

// A picture the image addon drew, found from the cell's tile without copying the picture.
function drawnPictureBox(col, row) {
  const line = term._core.buffer.lines.get(row);
  if (!line || col >= term.cols || !(line.getBg(col) & 0x10000000)) return null;
  const tile = line._extendedAttrs?.[col];
  if (!tile || !(tile.imageId > 0) || tile.tileId < 0) return null;
  const spec = images._storage?._images?.get(tile.imageId);
  if (!spec?.actual || !spec.actualCellSize?.width) return null;
  const perRow = Math.ceil(spec.actual.width / spec.actualCellSize.width);
  const cw = cellWidth();
  const rh = rowHeight();
  return {
    left: (col - (tile.tileId % perRow)) * cw,
    top: (row - Math.floor(tile.tileId / perRow) - term.buffer.active.viewportY) * rh,
    width: spec.actual.width * cw / spec.actualCellSize.width,
    height: spec.actual.height * rh / spec.actualCellSize.height,
    round: 2,
  };
}

const pictureHover = document.createElement('div');
pictureHover.id = 'picture-hover';
screenEl.appendChild(pictureHover);
const hover = { x: -1, y: -1, frame: 0, key: '' };

function showPictureHover() {
  hover.frame = 0;
  const pic = hover.x < 0 || mouseHeld ? null : pictureAt(hover.x, hover.y);
  document.body.classList.toggle('r7-picture', !!pic);
  if (!pic) { pictureHover.classList.remove('on'); hover.key = ''; return; }
  const b = pic.box;
  const key = `${b.left}|${b.top}|${b.width}|${b.height}`;
  if (key === hover.key) return;
  hover.key = key;
  Object.assign(pictureHover.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, borderRadius: `${b.round}px` });
  pictureHover.classList.add('on');
}
function queuePictureHover() {
  if (!hover.frame) hover.frame = requestAnimationFrame(showPictureHover);
}
screenEl.addEventListener('mousemove', (e) => { hover.x = e.clientX; hover.y = e.clientY; queuePictureHover(); });
screenEl.addEventListener('mouseleave', () => { hover.x = -1; queuePictureHover(); });
term.onRender(() => { if (hover.x >= 0) queuePictureHover(); });

let pictureDown = null;
screenEl.addEventListener('mousedown', (e) => { pictureDown = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }, true);
screenEl.addEventListener('mouseup', (e) => {
  const down = pictureDown;
  pictureDown = null;
  queuePictureHover();
  if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || term.hasSelection()) return;
  pictureAt(e.clientX, e.clientY)?.open();
}, true);

function scrollBy(px, why = 'wheel') {
  const h = rowHeight();
  if (!scroll.frame) scroll.pos = scroll.target = scroll.shifted ? scroll.pos : term.buffer.active.viewportY * h;
  scroll.target = Math.max(0, Math.min(term.buffer.active.baseY * h, scroll.target + px));
  if (scroll.target >= term.buffer.active.baseY * h - 1) followBottom = true;
  else leaveBottom(why);
  if (!scroll.frame) {
    scroll.last = performance.now();
    scroll.frame = requestAnimationFrame(stepScroll);
  }
}

function stepScroll(now) {
  if (document.hidden) { resetScroll(); return; }
  const dt = Math.min(50, now - scroll.last);
  scroll.last = now;
  const max = term.buffer.active.baseY * rowHeight();
  // Heading for the bottom aims at where the bottom is now, not where it was when the
  // scroll began: output that arrived meanwhile would otherwise strand the view above it.
  if (scroll.target > max || followBottom) scroll.target = max;
  scroll.pos += (scroll.target - scroll.pos) * (1 - Math.exp(-dt / Math.max(1, cfg.scrollEaseMs ?? 45)));
  if (Math.abs(scroll.target - scroll.pos) < 0.5) scroll.pos = scroll.target;
  placeScroll(scroll.pos);
  scroll.frame = scroll.pos === scroll.target ? 0 : requestAnimationFrame(stepScroll);
  if (!scroll.frame) keepBottom();
}

function placeScroll(pos) {
  const h = rowHeight();
  const dpr = window.devicePixelRatio || 1;
  let row = Math.floor(pos / h + 1e-6);
  let offset = Math.round((pos - row * h) * dpr) / dpr;
  if (offset >= h - 0.01) { row += 1; offset = 0; }
  if (row === term.buffer.active.viewportY) { scroll.pending = null; showScroll(row, offset); return; }
  // The grid redraws on xterm's next frame; the shift waits for it so both move together.
  scroll.pending = { row, offset };
  scroll.row = row;
  term.scrollToLine(row);
}

function showScroll(row, offset) {
  // No spare row may survive at the live bottom or leak into the bottom padding.
  if (row >= term.buffer.active.baseY) offset = 0;
  scroll.row = row;
  scroll.shifted = offset > 0;
  screenEl.style.transform = offset ? `translateY(${-offset}px)` : '';
  extraRow.hidden = !offset;
  if (!offset) return;
  extraRow.style.top = `${term.rows * rowHeight()}px`;
  extraRow.style.height = `${offset}px`;
  drawExtraRow(row + term.rows);
}

function resetScroll() {
  cancelAnimationFrame(scroll.frame);
  scroll.frame = 0;
  scroll.pending = null;
  scroll.shifted = false;
  screenEl.style.transform = '';
  extraRow.hidden = true;
  extraRow.style.height = '0px';
  scroll.extraKey = '';
}

document.addEventListener('visibilitychange', () => { if (document.hidden) resetScroll(); });
term.onRender(() => {
  const p = scroll.pending;
  if (p && term.buffer.active.viewportY === p.row) { scroll.pending = null; showScroll(p.row, p.offset); }
  else if (scroll.shifted && term.buffer.active.viewportY === scroll.row) drawExtraRow(scroll.row + term.rows);
});
// Scrolls that don't come from here (typing jumps to the bottom, new output) drop the shift.
term.onScroll((y) => { if (y !== scroll.row) resetScroll(); });

// Dragging a selection past the top edge scrolls up on purpose. Anything else that
// leaves the view above the bottom while it should follow (xterm resyncing its own
// scroll position, a window coming back from hidden) is put back after the frame.
let mouseHeld = false;
window.addEventListener('mousedown', () => { mouseHeld = true; }, true);
window.addEventListener('mouseup', () => { mouseHeld = false; }, true);
window.addEventListener('blur', () => { mouseHeld = false; });
term.onRender(() => {
  const b = term.buffer.active;
  if (!followBottom || scroll.frame || b.type !== 'normal' || b.viewportY === b.baseY) return;
  if (mouseHeld) { leaveBottom('drag'); return; }
  r7.log('info', 'scroll.rejoin', { session: cfg.session, rows: b.baseY - b.viewportY, hidden: document.hidden });
  term.scrollToBottom();
});

function paletteColor(n) {
  if (n < 16) return colors.palette[n];
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    n -= 16;
    return `rgb(${v[Math.floor(n / 36)]},${v[Math.floor(n / 6) % 6]},${v[n % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function drawExtraRow(index) {
  const line = term.buffer.active.getLine(index);
  const key = `${index}|${line ? line.translateToString() : ''}|${colors.fg}|${colors.bg}`;
  if (key === scroll.extraKey) return;
  scroll.extraKey = key;
  extraRow.textContent = '';
  if (!line) return;
  const w = cellWidth();
  const h = rowHeight();
  extraRow.style.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
  extraRow.style.lineHeight = `${h}px`;
  const cell = line.getCell(0);
  for (let x = 0; x < term.cols; x++) {
    line.getCell(x, cell);
    const width = cell.getWidth();
    if (!width) continue;
    let fg = cell.isFgDefault() ? colors.fg : cell.isFgRGB() ? hex(cell.getFgColor()) : paletteColor(cell.getFgColor());
    let bg = cell.isBgDefault() ? '' : cell.isBgRGB() ? hex(cell.getBgColor()) : paletteColor(cell.getBgColor());
    if (cell.isInverse()) [fg, bg] = [bg || colors.bg, fg];
    const span = document.createElement('span');
    span.textContent = cell.getChars() || ' ';
    span.style.width = `${w * width}px`;
    span.style.height = `${h}px`;
    span.style.color = fg;
    if (bg) span.style.background = bg;
    if (cell.isBold()) span.style.fontWeight = 'bold';
    if (cell.isItalic()) span.style.fontStyle = 'italic';
    if (cell.isDim()) span.style.opacity = '0.5';
    if (cell.isUnderline()) span.style.textDecoration = 'underline';
    if (cell.isInvisible()) span.style.color = 'transparent';
    extraRow.appendChild(span);
  }
}

document.getElementById('term').addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;
  if (term.buffer.active.type !== 'normal' || term.modes.mouseTrackingMode !== 'none') return;
  e.preventDefault();
  e.stopPropagation();
  const px = e.deltaMode === 1 ? e.deltaY * rowHeight() : e.deltaMode === 2 ? e.deltaY * screenEl.clientHeight : e.deltaY;
  scrollBy(px * cfg.scrollSpeed);
}, { capture: true, passive: false });

// Scroll so a pixel position is at the top, from wherever the scroll is heading.
function scrollTo(px) {
  const h = rowHeight();
  const from = scroll.frame || scroll.shifted ? scroll.target : term.buffer.active.viewportY * h;
  scrollBy(px - from, 'jump');
}

// ---- jump between messages (Alt+Up / Alt+Down) -----------------------------------
// A template's `messageStart` regex marks the first row of each message (r7-Harness's
// user message box starts with ▏). Without one, shell prompt marks (OSC 133;A)
// are used. A jump puts the message one row below the top.

const promptMarks = [];
term.parser.registerOscHandler(133, (data) => {
  if (data[0] === 'A' && !cfg.messageStart) promptMarks.push(term.registerMarker(0));
  return false;
});
const messageStart = cfg.messageStart ? new RegExp(cfg.messageStart) : null;

function messageRows() {
  const buf = term.buffer.active;
  if (!messageStart) return [...new Set(promptMarks.filter((m) => !m.isDisposed && m.line >= 0).map((m) => m.line))].sort((a, b) => a - b);
  const rows = [];
  let inside = false;
  for (let y = 0; y < buf.length; y++) {
    // Ignore the centered column's leading margin.
    const hit = messageStart.test((buf.getLine(y)?.translateToString(true) || '').trimStart().slice(0, 4));
    if (hit && !inside) rows.push(y);
    inside = hit;
  }
  return rows;
}

function jumpMessage(dir) {
  const h = rowHeight();
  const top = (scroll.frame || scroll.shifted ? scroll.target / h : term.buffer.active.viewportY) + 1;
  const rows = messageRows();
  const row = dir < 0 ? rows.filter((r) => r < top - 0.5).pop() : rows.find((r) => r > top + 0.5);
  if (row === undefined) scrollTo(dir < 0 ? 0 : Infinity);
  else scrollTo((row - 1) * h);
}

// ---- clickable file paths -----------------------------------------------------
// Windows paths, WSL paths, ~/ and paths relative to the session's folder become
// links when they exist (checked by the app, cached for a while); Ctrl+click opens
// them with their default app (pictures in the viewer), or Explorer for a folder.

const PATH_RE = /(?:[A-Za-z]:\\[^\s"'`<>|*?]+|(?<![\w/.:~-])(?:~\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\/?)/g;
const pathCache = new Map();

function checkPath(text) {
  const hit = pathCache.get(text);
  if (hit && Date.now() - hit.at < 15000) return hit.win;
  const win = r7.checkPath(text, cfg.cwd, cfg.home);
  pathCache.set(text, { at: Date.now(), win });
  if (pathCache.size > 500) pathCache.delete(pathCache.keys().next().value);
  return win;
}

// A row's text with each character's cell column (wide characters take two).
function rowText(y) {
  const line = term.buffer.active.getLine(y - 1);
  if (!line) return null;
  let text = '';
  const col = [];
  const cell = line.getCell(0);
  for (let x = 0; x < term.cols; x++) {
    line.getCell(x, cell);
    if (!cell.getWidth()) continue;
    const ch = cell.getChars() || ' ';
    for (let i = 0; i < ch.length; i++) col.push(x);
    text += ch;
  }
  return { text, col };
}

function cleanPath(p) {
  return p.replace(/[.,:;)\]}'"]+$/, '').replace(/:\d+(?::\d+)?$/, '');
}

// Join up to three hard-wrapped path rows and check whether the resulting file exists.
const PATH_CHAR = /[\w.@+\-/\\~:]/;
function joinedPath(y) {
  const rows = [];
  let startY = y;
  // walk back while this row starts with a word that continues the row above's last word
  for (let i = 0; i < 2; i++) {
    const above = rowText(startY - 1), here = rowText(startY);
    if (!above || !here) break;
    const a = above.text.replace(/\s+$/, ''), lead = here.text.search(/\S/);
    if (!a || lead < 0 || !PATH_CHAR.test(a[a.length - 1]) || !/[/\\]/.test(a.slice(a.lastIndexOf(' ') + 1))) break;
    startY--;
  }
  for (let r = startY; r <= Math.min(startY + 2, y + 2); r++) {
    const row = rowText(r);
    if (!row) break;
    rows.push({ y: r, ...row });
  }
  return rows;
}

function wrappedLinks(y) {
  const rows = joinedPath(y);
  if (rows.length < 2) return [];
  // the first row's last word, then each next row's first word while the previous part reached its row's end
  const first = rows[0], a = first.text.replace(/\s+$/, '');
  const s0 = a.lastIndexOf(' ') + 1;
  let text = a.slice(s0);
  if (!/[/\\]/.test(text)) return [];
  const parts = [{ y: first.y, start: first.col[s0], end: first.col[a.length - 1] }];
  const tries = [];
  for (let i = 1; i < rows.length; i++) {
    const t = rows[i].text, lead = t.search(/\S/);
    if (lead < 0) break;
    const m = /^\S+/.exec(t.slice(lead))[0];
    const word = cleanPath(m);
    if (!word) break;
    text += word;
    parts.push({ y: rows[i].y, start: rows[i].col[lead], end: rows[i].col[lead + word.length - 1] });
    tries.push({ text: cleanPath(text), parts: parts.slice() });
    const end = t.replace(/\s+$/, '').length;
    if (lead + m.length < end || end < a.length - 3) break; // the word ended before the row did, or the row isn't full
  }
  return tries.filter((c) => c.parts.some((p) => p.y === y));
}

registerLinks(decorateLinks({
  provideLinks(y, callback) {
    const row = rowText(y);
    if (!row) return callback(undefined);
    const { text, col } = row;
    const found = [];
    for (const m of text.matchAll(PATH_RE)) {
      const p = cleanPath(m[0]);
      if (!p.includes('/') && !p.includes('\\')) continue;
      if (!/^([A-Za-z]:|~|\/)/.test(p) && !/\.\w+$/.test(p)) continue; // relative paths need a file extension
      found.push({ text: p, start: m.index, end: m.index + p.length - 1 });
    }
    const wrapped = wrappedLinks(y);
    if (!found.length && !wrapped.length) return callback(undefined);
    Promise.all([...found, ...wrapped].map((f) => checkPath(f.text))).then((wins) => {
      const links = [];
      // the longest existing joined path wins over its own pieces
      const joined = wrapped.map((w, i) => ({ ...w, win: wins[found.length + i] })).filter((w) => w.win).pop();
      if (joined) {
        const a = joined.parts[0], b = joined.parts[joined.parts.length - 1];
        links.push({
          text: joined.text,
          range: { start: { x: a.start + 1, y: a.y }, end: { x: b.end + 1, y: b.y } },
          decorations: { underline: true, pointerCursor: true },
          activate: () => r7.openPath(joined.win),
        });
      }
      const mine = joined?.parts.find((p) => p.y === y);
      found.forEach((f, i) => {
        if (!wins[i] || (mine && col[f.start] <= mine.end && col[f.end] >= mine.start)) return;
        links.push({
          text: f.text,
          range: { start: { x: col[f.start] + 1, y }, end: { x: col[f.end] + 1, y } },
          decorations: { underline: true, pointerCursor: true },
          activate: () => r7.openPath(wins[i]),
        });
      });
      callback(links.length ? links : undefined);
    });
  },
}));

// Clicking an italic quote block copies its text with wrapped paragraphs joined.
const QUOTE_RE = /^( +)▏(?: |$)/;
function quoteRow(y, indent) {
  const line = term.buffer.active.getLine(y - 1);
  if (!line) return null;
  const text = line.translateToString(true);
  const m = QUOTE_RE.exec(text);
  if (!m || /▕\s*$/.test(text) || (indent !== undefined && m[1].length !== indent)) return null;
  const body = text.slice(m[0].length).trimEnd();
  if (body) {
    let italic = false;
    for (let x = m[0].length; x < text.length && !italic; x++) italic = !!line.getCell(x)?.isItalic();
    if (!italic) return null;
  }
  return { indent: m[1].length, body, end: text.length };
}
function quoteBlock(y) {
  const row = quoteRow(y);
  if (!row) return null;
  let top = y, bottom = y;
  while (quoteRow(top - 1, row.indent)) top--;
  while (quoteRow(bottom + 1, row.indent)) bottom++;
  const rows = [];
  for (let r = top; r <= bottom; r++) rows.push(quoteRow(r, row.indent));
  if (!rows.some((q) => q.body)) return null;
  const width = Math.max(...rows.map((q) => q.body.length));
  let out = '';
  rows.forEach((q, i) => {
    if (i === 0) out = q.body;
    else if (!q.body) out += '\r\n';
    else if (rows[i - 1].body && softBreak(rows[i - 1].body, q.body, width)) out += ' ' + q.body;
    else out += '\r\n' + q.body;
  });
  return { top, bottom, indent: row.indent, last: rows[rows.length - 1].end, text: out.trim().replace(/(\r\n){3,}/g, '\r\n\r\n') };
}
registerLinks(decorateLinks({
  provideLinks(y, callback) {
    const block = quoteBlock(y);
    if (!block) return callback(undefined);
    callback([{
      text: 'Copy quote',
      range: { start: { x: block.indent + 1, y: block.top }, end: { x: Math.max(block.last, block.indent + 1), y: block.bottom } },
      decorations: { underline: true, pointerCursor: true },
      activate: () => {
        r7.writeClipboard(block.text);
        linkTip.textContent = 'Copied';
        linkTip.classList.add('on');
        placeTip();
        r7.log('info', 'quote.copy', { chars: block.text.length, rows: block.bottom - block.top + 1 });
      },
    }]);
  },
}, true));

// ---- find (Ctrl+Shift+F) --------------------------------------------------------

const findEl = document.getElementById('find');
const findText = document.getElementById('find-text');
const findCount = document.getElementById('find-count');
document.documentElement.style.setProperty('--font', term.options.fontFamily);
const findOptions = {
  decorations: {
    matchBackground: '#9367FB55', matchOverviewRuler: '#9367FB',
    activeMatchBackground: '#E1007A', activeMatchColorOverviewRuler: '#E1007A',
  },
};

function openFind() {
  findEl.hidden = false;
  leaveBottom('find');
  const selected = term.getSelection();
  if (selected && !selected.includes('\n')) findText.value = selected;
  findText.select();
  findText.focus();
  if (findText.value) search.findNext(findText.value, { ...findOptions, incremental: true });
}

function closeFind() {
  findEl.hidden = true;
  search.clearDecorations();
  findCount.textContent = '';
  term.focus();
}

search.onDidChangeResults(({ resultIndex, resultCount }) => {
  findCount.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : findText.value ? '0' : '';
});
findText.addEventListener('input', () => {
  if (findText.value) search.findNext(findText.value, { ...findOptions, incremental: true });
  else { search.clearDecorations(); findCount.textContent = ''; }
});
findText.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) search.findPrevious(findText.value, findOptions);
    else search.findNext(findText.value, findOptions);
  }
});

term.focus();
// After every script has run: the page can yield between scripts, and output that
// arrived first would miss the handlers the later ones add (marks, type-ahead, fading).
document.addEventListener('DOMContentLoaded', connect);

// ---- gliding cursor ---------------------------------------------------------------
// A block drawn over the grid that slides to its new cell in cfg.cursorGlideMs instead
// of jumping. It inverts the character under it, like Windows Terminal's filled box,
// and becomes an outline when the window loses focus. Shape changes a program asks for
// (DECSCUSR: bar, underline) and hiding (DECTCEM) are followed, unless settings.json's
// `cursor.shape` picks one (`r7shell cursor` changes it live). It blinks while the
// window is focused and the cursor has sat still for a moment.

const cursorEl = document.createElement('div');
cursorEl.id = 'glide-cursor';
screenEl.appendChild(cursorEl);
// Windows with a launch screen hold it until input.js sees the first attach: shown, or kept
// hidden for the launch screen.
const glide = { visible: true, hold: !!cfg.launch?.ready, forceShape: null, shape: 'block', x: -1, y: -1, viewportY: -1, frame: 0, shown: false };
let cursorLook = { shape: 'auto', width: 2, blinkMs: 331, ...(cfg.cursor || {}) };
let blinkTimer = 0;
let cursorDrawn = '';

function setCursorLook(look) {
  cursorLook = { ...cursorLook, ...look };
  glide.shown = false;
  restartBlink();
  queueCursor();
}
r7.onCursor(setCursorLook);

// Solid while typing or moving, blinking again once it has been still for a moment.
function restartBlink() {
  clearTimeout(blinkTimer);
  cursorEl.classList.remove('blink');
  if (!cursorLook.blinkMs || !document.hasFocus()) return;
  cursorEl.style.setProperty('--blink-period', `${cursorLook.blinkMs * 2}ms`);
  blinkTimer = setTimeout(() => cursorEl.classList.add('blink'), 500);
}
document.addEventListener('keydown', restartBlink, true);

term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
  const n = params[0] || 0;
  glide.shape = n === 3 || n === 4 ? 'underline' : n === 5 || n === 6 ? 'bar' : 'block';
  queueCursor();
  return true;
});
const watchCursorMode = (on) => (params) => {
  if (params.includes(25)) { glide.visible = on; queueCursor(); }
  return false;
};
term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, watchCursorMode(true));
term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, watchCursorMode(false));

function queueCursor() {
  if (!glide.frame) glide.frame = requestAnimationFrame(placeCursor);
}

function placeCursor() {
  glide.frame = 0;
  const b = term.buffer.active;
  const x = b.cursorX;
  const y = b.cursorY + b.baseY - b.viewportY;
  const show = glide.visible && !glide.hold && y >= 0 && y < term.rows;
  if (!show) {
    cursorEl.style.display = 'none';
    glide.shown = false;
    return;
  }
  if (x !== glide.x || y !== glide.y) restartBlink();
  const w = cellWidth();
  const h = rowHeight();
  // Appearing, scrolling and resizing jump straight there; only moves in place glide.
  const rowOffset = window.r7RowMotion?.(y) || 0;
  const snap = !glide.shown || b.viewportY !== glide.viewportY || !!rowOffset;
  const shape = glide.forceShape || (cursorLook.shape === 'auto' ? glide.shape : cursorLook.shape);
  const focused = document.hasFocus();
  const color = colors.cursor || colors.fg;
  const key = `${x}|${y}|${b.viewportY}|${w}|${h}|${rowOffset}|${snap}|${shape}|${focused}|${cursorLook.width}|${color}|${cfg.cursorGlideMs}`;
  // Status/output redraws do not change a stationary cursor's classes or styles.
  if (glide.shown && key === cursorDrawn) return;
  cursorDrawn = key;
  cursorEl.style.transition = snap ? 'none' : `transform ${cfg.cursorGlideMs}ms cubic-bezier(.2, .8, .3, 1)`;
  cursorEl.style.display = '';
  cursorEl.style.width = `${w}px`;
  cursorEl.style.height = `${h}px`;
  cursorEl.style.transform = `translate(${x * w}px, ${y * h}px)`;
  cursorEl.style.translate = rowOffset ? `0 ${rowOffset}px` : '';
  cursorEl.classList.remove('block', 'bar', 'underline', 'outline');
  cursorEl.classList.add(shape);
  cursorEl.classList.toggle('blurred', !focused);
  cursorEl.style.setProperty('--cursor-width', `${cursorLook.width}px`);
  cursorEl.style.setProperty('--cursor', color);
  glide.shown = true;
  glide.x = x;
  glide.y = y;
  glide.viewportY = b.viewportY;
}

term.onCursorMove(queueCursor);
term.onRender(queueCursor);
window.addEventListener('r7-dock-layout', queueCursor);
term.onResize(() => { glide.shown = false; queueCursor(); });
window.addEventListener('r7-clear', () => { glide.shown = false; queueCursor(); });
window.addEventListener('focus', () => { restartBlink(); queueCursor(); });
window.addEventListener('blur', () => { restartBlink(); queueCursor(); });
colorListeners.push(queueCursor);
