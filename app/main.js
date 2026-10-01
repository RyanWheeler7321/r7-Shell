'use strict';
// r7Shell app: thin window host. Sessions live in the WSL daemon, so this
// process can quit, crash or update without losing a single terminal.

const { app, BrowserWindow, ipcMain, clipboard, shell, screen, nativeTheme } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const shared = require('./shared');

const { ROOT, VERSION, STATE, DEFAULTS, settingsFile, readJson, writeJson, token, winToWsl } = shared;
const settings = shared.readSettings();
const argv = process.argv.slice(1);
const flag = (name) => argv.includes(name);
const GPU = settings.gpu && !flag('--no-gpu');
if (!GPU) {
  // Zero-GPU mode: software drawing, and no separate GPU process at all.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
}
// Draw colors as exact sRGB values like Windows Terminal; the monitor profile made every color darker.
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const log = shared.makeLog('app');
const api = (method, route, body) => shared.api(settings.port, method, route, body);
const ensureDaemon = () => shared.ensureDaemon(settings, log);

// ---- windows -------------------------------------------------------------

const windows = new Map(); // session id -> BrowserWindow
const pins = new Map(); // session id -> entries from `r7shell pin`, newest first
const commands = new Map(); // control commands added by extras
const windowHooks = []; // extras' (id, win) callbacks for every new window
const boundsFile = path.join(STATE, 'windows.json');
const savedBounds = readJson(boundsFile, {});
let quittingKeepSessions = false;
let saveTimer = null;

function saveBounds(key, win) {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  savedBounds[key] = { ...win.getBounds(), ...(win.physical ? { physical: win.physical } : {}) };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(boundsFile, savedBounds), 400);
}

function visibleBounds(b) {
  if (!b) return null;
  const on = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 80 > a.x && b.x < a.x + a.width - 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
  return on ? b : null;
}

// Bounds in DIPs can't land on every pixel of a monitor scaled 150%: a window tiled at
// 1280px came back 1281px wide and a pixel or two over the next monitor or window.
// So each window's exact pixel rect is kept from its WM_MOVE and WM_SIZE messages
// (frameless: the client area is the whole window), and a reattached window is put
// back on it with SetWindowPos, one hidden PowerShell for all windows that reopen.
// A pixel-only change can leave the DIP bounds the same, with no move or resize event,
// so these messages save too.
function trackPhysical(win, changed) {
  win.hookWindowMessage(0x0003, (_w, l) => { win.physical = { ...win.physical, x: l.readInt16LE(0), y: l.readInt16LE(2) }; changed(); });
  win.hookWindowMessage(0x0005, (_w, l) => { win.physical = { ...win.physical, width: l.readUInt16LE(0), height: l.readUInt16LE(2) }; changed(); });
}

let restores = [];
let restoreTimer = null;
function restorePhysical(win, p) {
  if (!p || ![p.x, p.y, p.width, p.height].every(Number.isFinite)) return;
  restores.push({ hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(), ...p });
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    const list = restores;
    restores = [];
    const calls = list.map((r) => `[void][R.W]::SetWindowPos([IntPtr]${r.hwnd}, [IntPtr]0, ${r.x}, ${r.y}, ${r.width}, ${r.height}, 0x14)`).join('; ');
    const script = "Add-Type -Name W -Namespace R -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int c, uint f); [DllImport(\"user32.dll\")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);'; "
      + `[void][R.W]::SetThreadDpiAwarenessContext([IntPtr]-4); ${calls}`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => {
      log(err ? 'warn' : 'info', 'window.restore', { windows: list.length, ...(err ? { error: err.message.slice(0, 200) } : {}) });
    });
  }, 300);
}

function centeredNew() {
  const a = screen.getPrimaryDisplay().workArea;
  const width = Math.min(settings.newWindowSize.width, a.width);
  const height = Math.min(settings.newWindowSize.height, a.height);
  return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
}

function openWindow(session, { activate = true } = {}) {
  const existing = windows.get(session.id);
  if (existing && !existing.isDestroyed()) {
    if (activate) existing.focus();
    return existing;
  }
  const cfg = shared.rendererConfig(session, settings, GPU);
  const theme = cfg.theme;
  // A session that just started opens at the standard size; one being reattached
  // (app restart, reopen) keeps where its window was. Ids get reused, so age decides.
  const fresh = Date.now() - (Date.parse(session.created || '') || 0) < 15000;
  const bounds = (!fresh && visibleBounds(savedBounds[session.id])) || centeredNew();
  const win = new BrowserWindow({
    ...bounds, minWidth: 320, minHeight: 200, show: false, title: session.title, backgroundColor: theme.background || '#000000',
    frame: false, thickFrame: false, autoHideMenuBar: true, icon: path.join(ROOT, 'app', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: true },
  });
  win.setMenu(null);
  // Windows scales a new window's size by the primary monitor's DPI; set it again so
  // windows on monitors with a different scale come back at their saved size.
  if (bounds.x !== undefined) win.setBounds(bounds);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { cfg: JSON.stringify(cfg) } });
  win.once('ready-to-show', () => {
    activate ? win.show() : win.showInactive();
    if (bounds.physical) restorePhysical(win, bounds.physical);
  });
  // Only save moves made after the window opened: re-applying saved bounds rounds by a
  // pixel or two on scaled monitors, and saving that would make windows creep.
  let opened = false;
  setTimeout(() => { opened = true; }, 1500);
  const remember = () => { if (!opened) return; saveBounds(session.id, win); };
  trackPhysical(win, remember);
  win.on('move', remember);
  win.on('resize', remember);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', (_e, d) => {
    log('error', 'renderer.gone', { id: session.id, reason: d.reason });
    if (!win.isDestroyed()) win.reload();
  });
  win.on('unresponsive', () => log('warn', 'renderer.unresponsive', { id: session.id }));
  win.created = Date.parse(session.created || '') || 0;
  win.on('closed', () => {
    windows.delete(session.id);
    // Closing a window ends its session, like any terminal, after a short grace so
    // `r7shell reopen` can bring it back. Quitting the app for a restart or update
    // leaves every session running.
    const keep = quittingKeepSessions || win.keepSession;
    if (!keep) closeLater(session.id);
    log('info', 'window.close', { id: session.id, keptSession: keep });
  });
  win.webContents.on('did-finish-load', () => { if (pins.has(session.id)) win.webContents.send('pins', pins.get(session.id)); });
  windows.set(session.id, win);
  for (const fn of windowHooks) {
    try { fn(session.id, win); } catch (e) { log('error', 'extras.window', { id: session.id, error: e.message }); }
  }
  log('info', 'window.open', { id: session.id, activate });
  return win;
}

// ---- undo close -------------------------------------------------------------
// A closed window's session keeps running for REOPEN_MS; launching the app with
// `--reopen`, or running `r7shell reopen`, brings the newest one back.

const REOPEN_MS = 10000;
const closing = new Map(); // session id -> { timer, at }

async function closeLater(id) {
  // Held from the start, so the app doesn't quit while the session is checked.
  closing.set(id, { timer: null, at: Date.now() });
  let s = null;
  try { s = await api('GET', `/sessions/${id}`); } catch {}
  if (!s?.alive) {
    closing.delete(id);
    api('DELETE', `/sessions/${id}`).catch(() => {});
    return quitIfEmpty();
  }
  if (!closing.has(id)) return;
  const timer = setTimeout(() => {
    closing.delete(id);
    api('DELETE', `/sessions/${id}`).catch(() => {});
    log('info', 'window.close_final', { id });
    quitIfEmpty();
  }, REOPEN_MS);
  closing.get(id).timer = timer;
}

async function reopenClosed() {
  const newest = [...closing.entries()].sort((a, b) => b[1].at - a[1].at)[0];
  if (!newest) {
    log('info', 'window.reopen_none', {});
    return { reopened: null };
  }
  const [id, { timer }] = newest;
  clearTimeout(timer);
  closing.delete(id);
  const s = await api('GET', `/sessions/${id}`);
  openWindow(s, { activate: true });
  log('info', 'window.reopen', { id });
  return { reopened: id };
}

// The app stays open while a closed window can still come back.
function quitIfEmpty() {
  if (!windows.size && !closing.size && !quittingKeepSessions) app.quit();
}

async function newSession(template, { cwd, activate = true } = {}) {
  template = template || settings.defaultTemplate;
  // A template marked `startsSlow` starts at once instead of waiting for its window:
  // its program reads the terminal size a second later, well after the window attaches.
  const slow = shared.readTemplate(template).startsSlow;
  const s = await api('POST', '/sessions', { template, cwd, open: false, deferSpawn: !slow });
  openWindow(s, { activate });
  return s;
}

// ---- control channel from the daemon (CLI -> daemon -> app) ----------------

let control = null;
function connectControl() {
  const ws = new WebSocket(`ws://127.0.0.1:${settings.port}/ws/app?token=${token()}`);
  control = ws;
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    const reply = (ok, result, error) => ws.send(JSON.stringify({ id: msg.id, ok, result, error }));
    try { reply(true, await handleCommand(msg.cmd, msg.args || {})); }
    catch (e) { log('error', 'control.error', { cmd: msg.cmd, error: e.message }); reply(false, null, e.message); }
  };
  ws.onclose = () => {
    if (control !== ws) return;
    log('warn', 'control.closed', {});
    setTimeout(async () => { try { await ensureDaemon(); } catch {} connectControl(); }, 1000);
  };
  ws.onerror = () => {};
}

async function handleCommand(cmd, a) {
  if (commands.has(cmd)) return commands.get(cmd)(a);
  if (cmd === 'open') {
    const s = await api('GET', `/sessions/${a.session}`);
    openWindow(s, { activate: !!a.activate });
    return { opened: s.id };
  }
  if (cmd === 'windows') {
    return [...windows.entries()].map(([id, w]) => ({ id, bounds: w.getBounds(), visible: w.isVisible(), focused: w.isFocused(), title: w.getTitle() }));
  }
  if (cmd === 'shot') {
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const img = await win.webContents.capturePage();
    const file = a.out || path.join(STATE, 'shots', `${a.session}-${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return { file, wsl: winToWsl(file), size: img.getSize() };
  }
  if (cmd === 'key') {
    // A key press inside this app's own window (no desktop input), for testing
    // the window's own shortcuts. `send` is the way to type into the program.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const modifiers = a.modifiers || [];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode, modifiers });
    if (a.keyCode.length === 1 && !modifiers.some((m) => m === 'control' || m === 'alt')) win.webContents.sendInputEvent({ type: 'char', keyCode: a.keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode, modifiers });
    return { sent: a.keyCode, modifiers };
  }
  if (cmd === 'js') {
    // Runs a line of JavaScript in one window's page, for tests.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    return { result: await win.webContents.executeJavaScript(String(a.code)) };
  }
  if (cmd === 'done') {
    // A program's turn finished: the window flashes until it's focused.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    win.webContents.send('done');
    return { done: a.session };
  }
  if (cmd === 'pin') {
    // `r7shell pin`: one entry of 1-8 images or videos, newest first, or --clear.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const list = a.clear ? [] : [{ id: `pin-${Date.now()}`, media: a.media || [] }, ...(pins.get(a.session) || [])];
    pins.set(a.session, list);
    win.webContents.send('pins', list);
    return { entries: list.length };
  }
  if (cmd === 'attention-test') {
    // Shows a made-up turn state in one window (glow, pins) until the next real update.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const data = { phase: '', completedMs: 0, seen: false, ...a.data };
    if (data.completedMs === 'now') data.completedMs = Date.now();
    const pinsCall = data.pins ? `r7shell.setPins(${JSON.stringify(data.pins)});` : '';
    await win.webContents.executeJavaScript(`r7shell.attention(${JSON.stringify(data)});${pinsCall}`);
    return { sent: { ...data, pins: data.pins?.length || 0 } };
  }
  if (cmd === 'hover') {
    // Moves the pointer inside this app's own window (no desktop input), for testing links.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
    return { x: a.x, y: a.y };
  }
  if (cmd === 'click') {
    // A left click inside this app's own window (no desktop input), for testing links.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const at = { x: a.x, y: a.y };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
    await new Promise((r) => setTimeout(r, 60));
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at });
    return at;
  }
  if (cmd === 'drag') {
    // A left-button drag inside this app's own window, for testing selection.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const steps = 8;
    const pause = () => new Promise((r) => setTimeout(r, 25));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: a.x1, y: a.y1 });
    await pause();
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: a.x1, y: a.y1 });
    for (let i = 1; i <= steps; i++) {
      await pause();
      const x = Math.round(a.x1 + (a.x2 - a.x1) * i / steps);
      const y = Math.round(a.y1 + (a.y2 - a.y1) * i / steps);
      win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x, y });
    }
    await pause();
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: a.x2, y: a.y2 });
    return { from: [a.x1, a.y1], to: [a.x2, a.y2] };
  }
  if (cmd === 'drag-resize') {
    // Resizes the window's width step by step, like dragging its edge, for testing
    // how the text follows; optional shots at given ms.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const b = win.getBounds();
    const t0 = Date.now();
    const times = [...(a.shots || [])];
    const shots = [];
    for (;;) {
      const t = Date.now() - t0;
      const k = Math.min(1, t / a.ms);
      win.setBounds({ ...b, width: Math.round(b.width + (a.width - b.width) * k) });
      if (times.length && t >= times[0]) {
        const ms = times.shift();
        const img = await win.webContents.capturePage();
        const file = path.join(STATE, 'shots', `${a.session}-resize-${ms}.png`);
        fs.writeFileSync(file, img.toPNG());
        shots.push(winToWsl(file));
      }
      if (k >= 1 && !times.length) break;
      await new Promise((r) => setTimeout(r, 16));
    }
    return shots;
  }
  if (cmd === 'wheel') {
    // Mouse wheel inside this app's own window (no desktop input), for testing
    // scrolling; optional shots at given ms after the first notch.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const [w, h] = win.getContentSize();
    const t0 = Date.now();
    const shots = [];
    const notch = () => win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: a.notches > 0 ? -100 : 100, wheelTicksY: a.notches > 0 ? -1 : 1, canScroll: true });
    for (let i = 0; i < Math.abs(a.notches); i++) {
      notch();
      if (a.gapMs) await new Promise((r) => setTimeout(r, a.gapMs));
    }
    for (const ms of a.shots || []) {
      await new Promise((r) => setTimeout(r, Math.max(0, ms - (Date.now() - t0))));
      const img = await win.webContents.capturePage();
      const file = path.join(STATE, 'shots', `${a.session}-wheel-${ms}.png`);
      fs.writeFileSync(file, img.toPNG());
      shots.push(winToWsl(file));
    }
    return shots;
  }
  if (cmd === 'displays') {
    return screen.getAllDisplays().map((d) => ({ id: d.id, primary: d.id === screen.getPrimaryDisplay().id, scale: d.scaleFactor, bounds: d.bounds, workArea: d.workArea }));
  }
  if (cmd === 'place') {
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    let b = a.bounds;
    if (a.display != null) {
      const d = screen.getAllDisplays()[a.display];
      if (!d) throw new Error(`no display ${a.display}`);
      const w = d.workArea;
      b = { x: w.x + Math.round(w.width * 0.1), y: w.y + Math.round(w.height * 0.1), width: Math.round(w.width * 0.8), height: Math.round(w.height * 0.8) };
    }
    win.setBounds(b);
    return win.getBounds();
  }
  if (cmd === 'reload') {
    for (const [id, w] of windows) if (!a.session || a.session === id) w.webContents.reloadIgnoringCache();
    return { reloaded: a.session || 'all' };
  }
  if (cmd === 'close') {
    const win = windows.get(a.session);
    if (win) { win.keepSession = true; win.destroy(); }
    return { closed: !!win };
  }
  if (cmd === 'reopen') return reopenClosed();
  if (cmd === 'cursor') {
    settings.cursor = { ...DEFAULTS.cursor, ...settings.cursor, ...a.look };
    writeJson(settingsFile, { ...readJson(settingsFile, {}), cursor: settings.cursor });
    for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send('cursor', settings.cursor);
    return settings.cursor;
  }
  if (cmd === 'quit') {
    setTimeout(() => quitKeepingSessions(), 50);
    return { quitting: true };
  }
  if (cmd === 'stats') {
    return { version: VERSION, gpu: GPU, windows: windows.size, metrics: app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpu: m.cpu.percentCPUUsage, memMB: Math.round(m.memory.workingSetSize / 1024) })) };
  }
  throw new Error(`unknown command "${cmd}"`);
}

async function quitKeepingSessions() {
  quittingKeepSessions = true;
  // Windows closed moments ago end now rather than coming back on the next start.
  await Promise.allSettled([...closing.keys()].map((id) => api('DELETE', `/sessions/${id}`)));
  log('info', 'app.quit', { keepSessions: true });
  app.quit();
}

// ---- renderer IPC ------------------------------------------------------------

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
ipcMain.on('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('path:check', (_e, p, cwd, home) => checkPath(p, cwd, home));
// A picture shown in a window (tool screenshot), saved so the default viewer can open it full size.
ipcMain.on('image:open', (_e, dataUrl) => {
  const file = shared.savePicture(dataUrl);
  if (file) shell.openPath(file).then((err) => { if (err) log('warn', 'image.open', { file, error: err }); });
});
ipcMain.on('path:open', (_e, win) => { shell.openPath(String(win)).then((err) => { if (err) log('warn', 'path.open', { path: win, error: err }); }); });
ipcMain.on('log', (e, lvl, ev, data) => log(lvl, ev, { from: 'renderer', ...data }));
ipcMain.on('set-title', (e, title) => BrowserWindow.fromWebContents(e.sender)?.setTitle(String(title)));
ipcMain.on('close-window', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('fullscreen', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.on('new-window', (_e, template) => newSession(template).catch((err) => log('error', 'new.error', { error: err.message })));
ipcMain.on('font-size', (_e, template, size) => { settings.fontSizes = shared.saveFontSize(template, size); });

function checkPath(p, cwd, home) {
  return shared.checkPath(p, cwd, home, settings.distro);
}

// ---- extras --------------------------------------------------------------------
// settings.json's `extras` folder can add templates, themes, renderer scripts and a
// main.js, called once at startup with the api below.

function loadExtras() {
  const dir = shared.extrasDir(settings);
  const file = dir && path.join(dir, 'main.js');
  if (!file || !fs.existsSync(file)) return;
  const extrasApi = {
    windows, log, settings, STATE, shared,
    send: (win, channel, data) => { if (!win.isDestroyed()) win.webContents.send(`x:${channel}`, data); },
    addCommand: (name, fn) => commands.set(name, fn),
    onWindow: (fn) => windowHooks.push(fn),
  };
  try {
    require(file)(extrasApi);
    log('info', 'extras.load', { file });
  } catch (e) { log('error', 'extras.error', { file, error: e.stack || e.message }); }
}

// ---- startup -----------------------------------------------------------------

// `--new=<template>` opens a window for a new session. A second launch's arguments
// come through Chromium, which moves switches ahead of plain words, so the
// separate `--new <template>` form only works for the first launch.
function newTemplate(args) {
  const eq = args.find((x) => x.startsWith('--new='));
  if (eq) return eq.slice(6);
  const i = args.indexOf('--new');
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

async function handleArgs(args) {
  if (!args.some((x) => x === '--new' || x.startsWith('--new='))) return;
  return newSession(newTemplate(args), { activate: !args.includes('--inactive') });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching r7Shell again opens another window with the default template.
  app.on('second-instance', (_e, args) => {
    const rest = args.slice(1);
    if (rest.includes('--reopen')) return reopenClosed().catch((e) => log('error', 'reopen.error', { error: e.message }));
    const wantsNew = rest.some((x) => x === '--new' || x.startsWith('--new='));
    const run = wantsNew ? handleArgs(rest) : newSession(settings.defaultTemplate);
    run.catch((e) => log('error', 'args.error', { error: e.message }));
  });
  app.on('window-all-closed', () => quitIfEmpty());
  app.setAppUserModelId('r7.shell');
  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    log('info', 'app.start', { version: VERSION, gpu: GPU, electron: process.versions.electron });
    try {
      await ensureDaemon();
    } catch (e) {
      log('error', 'daemon.unavailable', { error: e.message });
      const { dialog } = require('electron');
      dialog.showErrorBox('r7Shell', `The session daemon didn't start.\n${e.message}\nLog: ${STATE}\\logs`);
      app.quit();
      return;
    }
    connectControl();
    loadExtras();
    const activate = !flag('--inactive');
    const sessions = await api('GET', '/sessions');
    for (const s of sessions) openWindow(s, { activate });
    if (argv.some((x) => x === '--new' || x.startsWith('--new='))) await handleArgs(argv);
    else if (!sessions.length && !argv.includes('--reopen')) await newSession(settings.defaultTemplate, { activate });
  });
}
