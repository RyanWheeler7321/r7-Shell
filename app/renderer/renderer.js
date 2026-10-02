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
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
const unicode = new Unicode11Addon.Unicode11Addon();
term.loadAddon(unicode);
term.unicode.activeVersion = '11';
// A plain click opens links (dragging still selects).
term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => r7.openExternal(url)));
const search = new SearchAddon.SearchAddon();
term.loadAddon(search);
const images = new ImageAddon.ImageAddon();
term.loadAddon(images);
term.open(document.getElementById('term'));

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
fit.fit();

// ---- connection ---------------------------------------------------------------

const enc = new TextEncoder();
let ws = null;
let retryMs = 250;
let exited = false;
let snapshotHeader = null;

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
    if (exited || !harness.on) return;
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
let followBottom = true;
function leaveBottom(why) {
  if (!followBottom) return;
  followBottom = false;
  r7.log('info', 'scroll.leave', { session: cfg.session, why });
}
function writeOutput(data) {
  if (document.hidden) { hold(data); return; }
  term.write(data, keepBottom);
}
function keepBottom() {
  const b = term.buffer.active;
  if (followBottom && !scroll.frame && b.viewportY !== b.baseY) term.scrollToBottom();
}

// A minimized or covered window holds its output and writes it in one go when it shows
// again. Chromium slows a hidden window's timers to one a second (one a minute after 5
// minutes), and xterm parses output on timers, so it fell minutes behind and replayed
// them on restore. While the held output is parsed, `catchingUp` tells fade.js to skip
// fading and gliding it. Past HOLD_MAX the window takes a fresh copy of the screen instead.
const HOLD_MAX = 4 << 20;
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
  if (!heldBytes) return;
  const t0 = performance.now();
  const bytes = heldBytes;
  if (bytes > HOLD_MAX) {
    held = [];
    heldBytes = 0;
    r7.log('info', 'catchup', { session: cfg.session, bytes, fresh: true });
    ws?.close();
    return;
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of held) { all.set(chunk, at); at += chunk.length; }
  held = [];
  heldBytes = 0;
  catchingUp = true;
  term.write(all, () => {
    catchingUp = false;
    keepBottom();
    r7.log('info', 'catchup', { session: cfg.session, bytes, ms: Math.round(performance.now() - t0) });
  });
});

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
  fit.fit();
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
  fit.fit();
  sendJson({ type: 'resize', cols: term.cols, rows: term.rows });
  r7.saveFontSize(cfg.template, size);
}

// Copied text drops the padding the screen adds: spaces at line ends and trailing blank lines.
function selectedText() {
  return term.getSelection().split(/\r?\n/).map((line) => line.replace(/\s+$/, '')).join('\r\n').replace(/(\r\n)+$/, '');
}

async function paste() {
  const text = await r7.readClipboard();
  if (text) term.paste(text);
  // No text (an image, say): pass Ctrl+V through like Windows Terminal, so the program can paste the image itself.
  else sendInput('\x16');
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
  if (ctrl && (k === '=' || k === '+')) { setFontSize(fontPoints + 1); return false; }
  if (ctrl && k === '-') { setFontSize(fontPoints - 1); return false; }
  if (ctrl && k === '0') { setFontSize(cfg.font.size); return false; }
  if (ctrl && e.shiftKey && k === 'n') { r7.newWindow(); return false; }
  if (ctrl && e.shiftKey && k === 'w') { r7.closeWindow(); return false; }
  if (ctrl && e.shiftKey && k === 'r') { location.reload(); return false; }
  if (ctrl && e.shiftKey && k === 'f') { openFind(); return false; }
  if (e.altKey && e.shiftKey && !e.ctrlKey && k === 'd') { r7.newWindow(cfg.template); return false; }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && term.buffer.active.type === 'normal') {
    jumpMessage(e.key === 'ArrowUp' ? -1 : 1);
    return false;
  }
  if (ctrl && e.shiftKey && term.buffer.active.type === 'normal') {
    const rowsBy = { ArrowUp: -1, ArrowDown: 1, PageUp: -(term.rows - 1), PageDown: term.rows - 1 }[e.key];
    if (rowsBy) { scrollBy(rowsBy * rowHeight(), 'key'); return false; }
    if (e.key === 'Home') { scrollBy(-Infinity, 'key'); return false; }
    if (e.key === 'End') { scrollBy(Infinity, 'key'); return false; }
  }
  if (e.key === 'F11') { r7.toggleFullscreen(); return false; }
  return true;
});

document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setFontSize(fontPoints + (e.deltaY < 0 ? 1 : -1));
}, { passive: false, capture: true });

// Right-click copies the selection, or pastes when nothing is selected.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
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
}

// Other parts (the attention glow) redraw when the colors change.
const colorListeners = [];
let colorsQueued = false;
function colorsChanged() {
  if (colorsQueued) return;
  colorsQueued = true;
  queueMicrotask(() => { colorsQueued = false; for (const fn of colorListeners) fn(); });
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
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const c = parseColor(parts[i + 1]);
    if (c && Number(parts[i]) < 16) colors.palette[Number(parts[i])] = c;
  }
  colorsChanged();
  return false;
});
term.parser.registerOscHandler(10, (data) => { const c = parseColor(data); if (c) colors.fg = c; return false; });
// The cursor color goes to the page's cursor; xterm's own stays invisible.
term.parser.registerOscHandler(12, (data) => {
  const c = parseColor(data);
  if (!c) return false;
  colors.cursor = c;
  colorsChanged();
  return true;
});
term.parser.registerOscHandler(112, () => { colors.cursor = cfg.theme.cursor || ''; colorsChanged(); return true; });
term.parser.registerOscHandler(11, (data) => {
  const c = parseColor(data);
  if (c) { colors.bg = c; document.documentElement.style.setProperty('--bg', c); }
  return false;
});
term.parser.registerOscHandler(104, () => { colors.palette = ANSI.map((name) => cfg.theme[name] || '#888'); colorsChanged(); return false; });
term.parser.registerOscHandler(110, () => { colors.fg = cfg.theme.foreground || '#fff'; return false; });
term.parser.registerOscHandler(111, () => {
  colors.bg = cfg.theme.background || '#000';
  document.documentElement.style.setProperty('--bg', colors.bg);
  return false;
});
resetColors();

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

// ---- clicking a picture opens it full size ------------------------------------
// Reply pictures are page elements with a file path; tool screenshots are drawn by
// the image addon, so those are saved from its canvas first. A drag still selects.

function windowsPath(p) {
  const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  return drive ? `${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}` : `\\\\wsl.localhost\\${cfg.distro}${p.replace(/\//g, '\\')}`;
}

let pictureDown = null;
screenEl.addEventListener('mousedown', (e) => { pictureDown = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }, true);
screenEl.addEventListener('mouseup', (e) => {
  const down = pictureDown;
  pictureDown = null;
  if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || term.hasSelection()) return;
  for (const img of document.querySelectorAll('.r7-image img')) {
    const r = img.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && img.dataset.path) {
      r7.log('info', 'picture.open', { session: cfg.session, path: img.dataset.path });
      return r7.openPath(windowsPath(img.dataset.path));
    }
  }
  const rect = screenEl.getBoundingClientRect();
  const col = Math.floor((e.clientX - rect.left) / cellWidth());
  const row = Math.floor((e.clientY - rect.top) / rowHeight()) + term.buffer.active.viewportY;
  const canvas = images.getImageAtBufferCell(col, row);
  if (!canvas) return;
  r7.log('info', 'picture.open', { session: cfg.session, drawn: `${canvas.width}x${canvas.height}` });
  r7.openImage(canvas.toDataURL('image/png'));
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
  const dt = Math.min(50, now - scroll.last);
  scroll.last = now;
  const max = term.buffer.active.baseY * rowHeight();
  // Heading for the bottom aims at where the bottom is now, not where it was when the
  // scroll began: output that arrived meanwhile would otherwise strand the view above it.
  if (scroll.target > max || followBottom) scroll.target = max;
  scroll.pos += (scroll.target - scroll.pos) * (1 - Math.exp(-dt / cfg.scrollEaseMs));
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
  if (row === term.buffer.active.viewportY) { showScroll(row, offset); return; }
  // The grid redraws on xterm's next frame; the shift waits for it so both move together.
  scroll.pending = { row, offset };
  scroll.row = row;
  term.scrollToLine(row);
}

function showScroll(row, offset) {
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
}

term.onRender(() => {
  const p = scroll.pending;
  if (p && term.buffer.active.viewportY === p.row) { scroll.pending = null; showScroll(p.row, p.offset); }
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
    const hit = messageStart.test(buf.getLine(y)?.translateToString(true, 0, 4) || '');
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
// links when they exist (checked by the app, cached for a while); a click opens
// them with their default app, or Explorer for a folder.

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

term.registerLinkProvider({
  provideLinks(y, callback) {
    const line = term.buffer.active.getLine(y - 1);
    if (!line) return callback(undefined);
    // Build the row's text with each character's cell column (wide characters take two).
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
    const found = [];
    for (const m of text.matchAll(PATH_RE)) {
      let p = m[0].replace(/[.,:;)\]}'"]+$/, '').replace(/:\d+(?::\d+)?$/, '');
      if (!p.includes('/') && !p.includes('\\')) continue;
      if (!/^([A-Za-z]:|~|\/)/.test(p) && !/\.\w+$/.test(p)) continue; // relative paths need a file extension
      found.push({ text: p, start: m.index, end: m.index + p.length - 1 });
    }
    if (!found.length) return callback(undefined);
    Promise.all(found.map((f) => checkPath(f.text))).then((wins) => {
      const links = [];
      found.forEach((f, i) => {
        if (!wins[i]) return;
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
});

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
  const snap = !glide.shown || b.viewportY !== glide.viewportY;
  cursorEl.style.transition = snap ? 'none' : `transform ${cfg.cursorGlideMs}ms cubic-bezier(.2, .8, .3, 1)`;
  cursorEl.style.display = '';
  cursorEl.style.width = `${w}px`;
  cursorEl.style.height = `${h}px`;
  cursorEl.style.transform = `translate(${x * w}px, ${y * h}px)`;
  const shape = glide.forceShape || (cursorLook.shape === 'auto' ? glide.shape : cursorLook.shape);
  cursorEl.classList.remove('block', 'bar', 'underline', 'outline');
  cursorEl.classList.add(shape);
  cursorEl.classList.toggle('blurred', !document.hasFocus());
  cursorEl.style.setProperty('--cursor-width', `${cursorLook.width}px`);
  cursorEl.style.setProperty('--cursor', colors.cursor || colors.fg);
  glide.shown = true;
  glide.x = x;
  glide.y = y;
  glide.viewportY = b.viewportY;
}

term.onCursorMove(queueCursor);
term.onRender(queueCursor);
term.onResize(() => { glide.shown = false; queueCursor(); });
window.addEventListener('focus', () => { restartBlink(); queueCursor(); });
window.addEventListener('blur', () => { restartBlink(); queueCursor(); });
colorListeners.push(queueCursor);
