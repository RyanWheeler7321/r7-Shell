'use strict';
// r7-Shell app: thin window host. Sessions live in the WSL daemon, so this
// process can quit, crash or update without losing a single terminal.

const { app, BrowserWindow, ipcMain, clipboard, shell, screen, nativeTheme, nativeImage, Menu, dialog } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const shared = require('./shared');
const { saveImage } = require('./clipboard-image');

const { ROOT, VERSION, STATE, DEFAULTS, settingsFile, readJson, writeJson, token, winToWsl } = shared;
const settings = shared.readSettings();
const argv = process.argv.slice(1);
const flag = (name) => argv.includes(name);
// A restart runs the new copy beside the old one (restartHandoff), and Chromium locks a
// browser profile for the copy using it: sharing one held the new windows blank until
// the old app quit. So each copy takes the profile the other isn't using.
const slotFile = path.join(STATE, 'app-slot.json');
const lastSlot = readJson(slotFile, {}).slot || 'a';
const slot = flag('--handoff') ? (lastSlot === 'b' ? 'a' : 'b') : lastSlot;
if (slot === 'b') app.setPath('userData', `${app.getPath('userData')}-b`);
writeJson(slotFile, { slot });
const GPU = settings.gpu && !flag('--no-gpu');
if (!GPU) {
  // Zero-GPU mode: software drawing, and no separate GPU process at all.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
}
// Draw colors as exact sRGB values like Windows Terminal; the monitor profile made every color darker.
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Keep the configured device scale when moving between monitors.
if (settings.deviceScale) app.commandLine.appendSwitch('force-device-scale-factor', String(settings.deviceScale));

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
  // Save only settled window positions.
  if (quittingKeepSessions || handingOff || win.restorePending || noDisplays() || Date.now() < displaysSettleUntil) return;
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isFullScreen()) return;
  if (!visibleBounds(win.getBounds())) return;
  win.physical = fullPhysical(win, win.physical);
  savedBounds[key] = { ...win.getBounds(), ...(win.physical ? { physical: win.physical } : {}) };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(boundsFile, savedBounds), 400);
}

// A saved spot in today's window units, from its pixel rect when it has one: the units of a
// monitor change with the scale setting (`deviceScale`), the pixels don't.
function savedSpot(b) {
  const p = b?.physical;
  if (!p || ![p.x, p.y, p.width, p.height].every(Number.isFinite) || noDisplays()) return b;
  return { ...b, ...screen.screenToDipRect(null, p) };
}

function visibleBounds(b) {
  if (!b) return null;
  // With no monitors to check against (see waitForDisplays), a saved spot is trusted.
  if (noDisplays()) return b;
  const on = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 80 > a.x && b.x < a.x + a.width - 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
  return on ? b : null;
}

// Keep saved positions while displays are absent.
function noDisplays() { return !screen.getAllDisplays().length; }

function waitForDisplays(ms) {
  if (!noDisplays()) return Promise.resolve();
  log('warn', 'displays.none', {});
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (noDisplays() && Date.now() - start < ms) return;
      clearInterval(timer);
      log('info', 'displays.wait_end', { displays: screen.getAllDisplays().length, ms: Date.now() - start });
      resolve();
    }, 500);
  });
}

let displaysSettleUntil = 0;
function displaysChanged() {
  displaysSettleUntil = Date.now() + 3000;
  setTimeout(() => {
    if (noDisplays()) return;
    let moved = 0;
    const blind = [];
    for (const [id, win] of windows) {
      if (win.testOffscreen) continue;
      const b = savedBounds[id];
      if (win.blind && !win.isDestroyed()) { blind.push(id); continue; }
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen() || !visibleBounds(b)) continue;
      if (b.physical) restorePhysical(win, b.physical); else win.setBounds(b);
      moved++;
    }
    log('info', 'displays.restored', { displays: screen.getAllDisplays().length, windows: moved, reopened: blind.length });
    reopenBlind(blind);
  }, 1500);
}

// A window opened without monitors lays its page out at scale 1 and keeps that once
// Chromium sees the real 125-150% monitors: the page then draws at 1/scale, everything
// shrunk ("zoomed out"). So when monitors return those windows are closed and opened
// again on their saved spots, sessions kept, like an app restart.
async function reopenBlind(ids) {
  for (const id of ids) {
    const win = windows.get(id);
    if (!win || win.isDestroyed() || win.testOffscreen) continue;
    let s = null;
    try { s = await api('GET', `/sessions/${id}`); } catch {}
    if (!s?.alive) continue;
    win.keepSession = true;
    win.destroy();
    openWindow(s, { activate: false });
  }
}

// Bounds in DIPs can't land on every pixel of a monitor scaled 150%: a window tiled at
// 1280px came back 1281px wide and a pixel or two over the next monitor or window.
// So each window's exact pixel rect is kept from its WM_MOVE and WM_SIZE messages
// (frameless: the client area is the whole window), and a reattached window is put
// back on it with SetWindowPos, one hidden PowerShell for all windows that reopen.
// It's done twice: landing on a monitor with another scale resizes the window by the
// scale change a moment later.
// A pixel-only change can leave the DIP bounds the same, with no move or resize event,
// so these messages save too.
function trackPhysical(win, changed) {
  win.hookWindowMessage(0x0003, (_w, l) => { win.physical = { ...win.physical, x: l.readInt16LE(0), y: l.readInt16LE(2) }; changed(); });
  win.hookWindowMessage(0x0005, (_w, l) => { win.physical = { ...win.physical, width: l.readUInt16LE(0), height: l.readUInt16LE(2) }; changed(); });
}

// The full pixel rect: a window put back exactly where it was gets no WM_MOVE, so its
// position never reached `physical` and the next restart placed it by DIPs alone.
// dipToScreenRect fills what the messages didn't give.
function fullPhysical(win, p, dip) {
  if (p && [p.x, p.y, p.width, p.height].every(Number.isFinite)) return p;
  if (noDisplays() || win.isDestroyed()) return p;
  // From the saved DIP spot when given (null: the monitor that spot is on), else where it is now.
  const r = dip ? screen.dipToScreenRect(null, dip) : screen.dipToScreenRect(win, win.getBounds());
  return { x: r.x, y: r.y, width: r.width, height: r.height, ...p };
}

let restores = [];
let restoreTimer = null;
function restorePhysical(win, p, dip, minimized = false, place = true) {
  win.restorePending = (win.restorePending || 0) + 1;
  const finish = (ok) => { win.restorePending--; return ok; };
  let hwnd;
  try {
    if (win.isDestroyed()) throw new Error('Window closed before physical restoration');
    p = fullPhysical(win, p, dip);
    if (!p || ![p.x, p.y, p.width, p.height].every(Number.isInteger) || p.width <= 0 || p.height <= 0) throw new Error('Physical restoration geometry unavailable');
    hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  } catch (e) {
    log('warn', 'window.restore', { windows: 1, failed: 1, error: e.message });
    return Promise.resolve(finish(false));
  }
  return new Promise((resolve) => {
    restores.push({ hwnd, id: win.sessionId, ...p, minimized, place, resolve: (ok) => resolve(finish(ok)) });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const list = restores;
      restores = [];
      restoreTimer = null;
      const args = (r) => `[IntPtr]${r.hwnd}, ${r.x}, ${r.y}, ${r.width}, ${r.height}`;
      const first = list.map((r, i) => `$error${i} = ${r.place ? `[R.Restore]::Place(${args(r)})` : "''"}`).join('; ');
      const second = list.map((r, i) => r.place ? `$error${i} += [R.Restore]::Place(${args(r)})` : '').filter(Boolean).join('; ');
      const checks = list.map((r, i) => r.place ? `$error${i} += [R.Restore]::CheckRect(${args(r)})` : '').filter(Boolean).join('; ');
      const shows = list.map((r, i) => `$actual${i} = [R.Restore]::Rect([IntPtr]${r.hwnd}); ${r.minimized ? `if ([string]::IsNullOrEmpty($error${i})) { $error${i} += [R.Restore]::ShowMinimized([IntPtr]${r.hwnd}) }` : ''}`).join('; ');
      const results = list.map((r, i) => `@{ ok = [string]::IsNullOrEmpty($error${i}); error = $error${i}; actual = $actual${i} }`).join('; ');
      const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace R {
  public static class Restore {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int c, uint f);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    public static string ShowMinimized(IntPtr h) {
      ShowWindow(h, 7);
      return IsIconic(h) ? "" : "SW_SHOWMINNOACTIVE failed; ";
    }
    public static string Place(IntPtr h, int x, int y, int w, int height) {
      return SetWindowPos(h, IntPtr.Zero, x, y, w, height, 0x14) ? "" : "SetWindowPos: " + new Win32Exception(Marshal.GetLastWin32Error()).Message + "; ";
    }
    public static int[] Rect(IntPtr h) {
      RECT r;
      if (!GetWindowRect(h, out r)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return new int[] { r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top };
    }
    public static string CheckRect(IntPtr h, int x, int y, int w, int height) {
      RECT r;
      if (!GetWindowRect(h, out r)) return "GetWindowRect: " + new Win32Exception(Marshal.GetLastWin32Error()).Message + "; ";
      if (r.Left == x && r.Top == y && r.Right-r.Left == w && r.Bottom-r.Top == height) return "";
      return String.Format("Physical rect mismatch: expected {0},{1},{2},{3}, got {4},{5},{6},{7}; ", x, y, w, height, r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top);
    }
  }
}
'@
if ([R.Restore]::SetThreadDpiAwarenessContext([IntPtr]-4) -eq [IntPtr]::Zero) { throw 'SetThreadDpiAwarenessContext(-4) failed' }
${[first, list.some((r) => r.place) ? 'Start-Sleep -Milliseconds 250' : '', second, checks, shows].filter(Boolean).join('; ')}
ConvertTo-Json -Compress -InputObject @(${results})
`;
      const done = (err, stdout, stderr) => {
        let results = [];
        let error = '';
        try {
          if (err) throw new Error(String(stderr || err.message).trim());
          results = JSON.parse(stdout);
          if (!Array.isArray(results) || results.length !== list.length || results.some((r) => typeof r?.ok !== 'boolean')) throw new Error('Missing native restoration results');
          error = results.find((r) => !r.ok)?.error || '';
        } catch (e) { results = []; error = e.message; }
        const failed = list.filter((_r, i) => results[i]?.ok !== true).length;
        log(failed ? 'warn' : 'info', 'window.restore', { windows: list.length, failed, ...(failed ? { error: (error || 'Native physical restoration failed').replace(/\s+/g, ' ').slice(0, 240) } : {}) });
        list.forEach((r, i) => {
          const a = results[i]?.actual;
          const actual = Array.isArray(a) && a.length === 4 ? { x: a[0], y: a[1], width: a[2], height: a[3] } : null;
          log(results[i]?.ok ? 'info' : 'warn', 'window.restore_rect', { id: r.id, hwnd: r.hwnd, expected: r.place ? { x: r.x, y: r.y, width: r.width, height: r.height } : null, actual, minimized: r.minimized, ok: results[i]?.ok === true, error: results[i]?.error || error || null });
          r.resolve(results[i]?.ok === true);
        });
      };
      try {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, done);
      } catch (e) { done(e); }
    }, 300);
  });
}

// Windows lays a maximized window 11px past its monitor on every side (the frame width at
// 125%), and with no frame DWM paints that overhang grey on the neighbouring monitors; a
// window region doesn't hide it. So a maximize becomes a plain window covering the work
// area, and maximizing that window again puts the earlier spot back.
function fillWorkArea(win) {
  if (win.isDestroyed() || win.testOffscreen) return;
  const hwnd = hwndOf(win);
  const rect = (r) => (r ? `${r.x},${r.y},${r.width},${r.height}` : '');
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace R {
  public static class Fill {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO m);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int c, uint f);
    static string S(RECT r) { return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top); }
    // filled: the work-area rect this window was put on last time; back: where it was before that.
    public static string Run(IntPtr h, string filled, string back) {
      if (!IsZoomed(h)) return "not maximized";
      MONITORINFO m = new MONITORINFO { Size = Marshal.SizeOf(typeof(MONITORINFO)) };
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref m)) return "monitor failed";
      ShowWindow(h, 4);   // SW_SHOWNOACTIVATE: out of maximize without taking focus
      RECT from; GetWindowRect(h, out from);
      int[] t;
      if (back != "" && S(from) == filled) t = Array.ConvertAll(back.Split(','), int.Parse);
      else t = new int[] { m.Work.Left, m.Work.Top, m.Work.Right - m.Work.Left, m.Work.Bottom - m.Work.Top };
      for (int i = 0; i < 2; i++) SetWindowPos(h, IntPtr.Zero, t[0], t[1], t[2], t[3], 0x14);
      RECT now; GetWindowRect(h, out now);
      return (S(now) == S(m.Work) ? "filled " : "back ") + S(from) + " " + S(now);
    }
  }
}
'@
[void][R.Fill]::SetThreadDpiAwarenessContext([IntPtr]-4)
[R.Fill]::Run([IntPtr]${hwnd}, '${rect(win.filled)}', '${rect(win.filledFrom)}')
`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
    const result = err ? String(stderr || err.message).trim().slice(0, 240) : stdout.trim();
    const m = /^(filled|back) (-?\d+),(-?\d+),(\d+),(\d+) (-?\d+),(-?\d+),(\d+),(\d+)$/.exec(result);
    if (m && !win.isDestroyed()) {
      const [fx, fy, fw, fh, nx, ny, nw, nh] = m.slice(2).map(Number);
      if (m[1] === 'filled') { win.filledFrom = { x: fx, y: fy, width: fw, height: fh }; win.filled = { x: nx, y: ny, width: nw, height: nh }; }
      else { win.filledFrom = null; win.filled = null; }
    }
    log(m ? 'info' : 'warn', 'window.fill', { id: win.sessionId, result });
  });
}

function centeredNew() {
  const a = screen.getPrimaryDisplay().workArea;
  const width = Math.min(settings.newWindowSize.width, a.width);
  const height = Math.min(settings.newWindowSize.height, a.height);
  return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
}

// Sessions another app shows in its own panel (template `embeddedIn`) get no window here.
function embedded(session) {
  return !!shared.readTemplate(session.template).embeddedIn;
}

// These are only the hidden starting dimensions. Electron's mixed-DPI desktop
// coordinates aren't reliable for placing a test window outside the real monitors.
function offscreenBounds() {
  return { width: settings.newWindowSize.width, height: settings.newWindowSize.height };
}

function showOffscreen(win, id) {
  if (win.isDestroyed()) return;
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  // One native transaction: place and check while hidden, then show without
  // activation and check again. No Electron show call can precede the placement.
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace R {
  public static class Offscreen {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int c, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
    static void Check(bool ok, string action) {
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), action);
    }
    static RECT Desktop() {
      int x = GetSystemMetrics(76), y = GetSystemMetrics(77);
      int w = GetSystemMetrics(78), h = GetSystemMetrics(79);
      if (w <= 0 || h <= 0) throw new Exception("No physical desktop bounds; test window stays hidden");
      return new RECT { Left=x, Top=y, Right=checked(x+w), Bottom=checked(y+h) };
    }
    static RECT Rect(IntPtr h) {
      RECT r;
      Check(GetWindowRect(h, out r), "GetWindowRect");
      if (r.Right <= r.Left || r.Bottom <= r.Top) throw new Exception("Invalid native window size");
      return r;
    }
    static void Outside(RECT r, RECT d) {
      if (r.Left < d.Right) throw new Exception("Native placement reached the physical desktop; test window hidden");
    }
    public static int[] Place(IntPtr h) {
      IntPtr previous = IntPtr.Zero;
      try {
        previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        Check(previous != IntPtr.Zero, "SetThreadDpiAwarenessContext(-4)");
        RECT d = Desktop(), r = Rect(h);
        int x = checked(d.Right+200), w = checked(r.Right-r.Left), height = checked(r.Bottom-r.Top);
        Check(SetWindowPos(h, IntPtr.Zero, x, d.Top, w, height, 0x94), "SetWindowPos hidden");
        Outside(Rect(h), Desktop());
        Check(SetWindowPos(h, IntPtr.Zero, x, d.Top, w, height, 0x54), "SetWindowPos show without activation");
        r = Rect(h); d = Desktop();
        Outside(r, d);
        return new int[] { r.Left, r.Top, checked(r.Right-r.Left), checked(r.Bottom-r.Top), d.Left, d.Top, checked(d.Right-d.Left), checked(d.Bottom-d.Top) };
      } catch {
        ShowWindow(h, 0);
        throw;
      } finally {
        if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
      }
    }
  }
}
'@
$r = [R.Offscreen]::Place([IntPtr]${hwnd})
@{ physical = @{ x=$r[0]; y=$r[1]; width=$r[2]; height=$r[3] }; desktop = @{ x=$r[4]; y=$r[5]; width=$r[6]; height=$r[7] } } | ConvertTo-Json -Compress
`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 16384 }, (err, stdout, stderr) => {
    if (win.isDestroyed()) return;
    let placed;
    try {
      if (err) throw new Error(String(stderr || err.message).trim());
      placed = JSON.parse(stdout);
      if (!placed.physical || !placed.desktop || ![placed.physical.x, placed.physical.y, placed.physical.width, placed.physical.height, placed.desktop.x, placed.desktop.y, placed.desktop.width, placed.desktop.height].every(Number.isFinite)
        || placed.physical.width <= 0 || placed.physical.height <= 0 || placed.desktop.width <= 0 || placed.desktop.height <= 0
        || placed.physical.x < placed.desktop.x + placed.desktop.width) throw new Error('Missing or unsafe native placement result');
    } catch (e) {
      win.hide();
      log('error', 'window.test_offscreen', { id, shown: false, error: e.message.replace(/\s+/g, ' ').slice(0, 240), action: 'Keep hidden; inspect native desktop bounds before another test' });
      return;
    }
    win.physical = placed.physical;
    win.offscreenReady = true;
    log('info', 'window.test_offscreen', { id, shown: true, ...placed, electronVisible: win.isVisible() });
  });
}

function openWindow(session, { activate = true, offscreen = false, above = '', physical = null, minimized = false, fullscreen = false } = {}) {
  if (embedded(session)) return null;
  const existing = windows.get(session.id);
  if (existing && !existing.isDestroyed()) {
    if (activate && !existing.testOffscreen) existing.focus();
    return existing;
  }
  const cfg = shared.rendererConfig(session, settings, GPU);
  const theme = cfg.theme;
  // A session that just started opens at the standard size; one being reattached
  // (app restart, reopen) keeps where its window was. Ids get reused, so age decides.
  const fresh = Date.now() - (Date.parse(session.created || '') || 0) < 15000;
  if (above && !validPhysical(physical)) throw new Error(`Missing handoff physical rect: ${session.id}`);
  const saved = physical ? { ...screen.screenToDipRect(null, physical), physical } : !fresh && !offscreen && visibleBounds(savedSpot(savedBounds[session.id]));
  const bounds = offscreen ? offscreenBounds() : saved || centeredNew();
  if (!saved && !fresh && savedBounds[session.id]) log('warn', 'window.offscreen', { id: session.id, saved: savedBounds[session.id], displays: screen.getAllDisplays().map((d) => d.workArea) });
  const win = new BrowserWindow({
    ...bounds, minWidth: 320, minHeight: 200, show: false, skipTaskbar: offscreen, title: session.title, backgroundColor: theme.background || '#000000',
    frame: false, thickFrame: false, autoHideMenuBar: true, icon: path.join(ROOT, 'app', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: !offscreen },
  });
  win.testOffscreen = offscreen;
  win.sessionId = session.id;
  let opened = false;
  win.setMenu(null);
  // Windows scales a new window's size by the primary monitor's DPI; set it again so
  // windows on monitors with a different scale come back at their saved size.
  if (bounds.x !== undefined) win.setBounds(bounds);
  win.loadFile(path.join(__dirname, 'renderer', cfg.fit ? 'fit.html' : 'index.html'), { query: { cfg: JSON.stringify(cfg) } });
  win.once('ready-to-show', async () => {
    if (offscreen) return showOffscreen(win, session.id);
    if (above) return;
    activate ? win.show() : win.showInactive();
    if (saved) await restorePhysical(win, bounds.physical, saved);
    if (!win.isDestroyed()) opened = true;
  });
  // Restart handoff: the old app's window stays up, live, until this one has drawn its
  // screen; then this one shows right above it, so nothing moves in the stack.
  if (above && !offscreen) {
    win.shown = waitAttach(win).then(async () => {
      if (win.isDestroyed()) throw new Error(`Handoff window closed: ${session.id}`);
      if (!await restorePhysical(win, bounds.physical, saved || bounds, minimized && !fullscreen)) throw new Error(`Handoff physical restoration failed: ${session.id}`);
      if (win.isDestroyed()) throw new Error(`Handoff window closed: ${session.id}`);
      const old = `window:${above}:0`;
      const stack = () => { try { win.moveAbove(old); } catch (e) { log('warn', 'handoff.zorder', { id: session.id, error: e.message }); } };
      if (fullscreen) {
        win.once('leave-full-screen', () => restorePhysical(win, bounds.physical, saved || bounds));
        win.setFullScreen(true);
      }
      if (fullscreen && minimized && !await restorePhysical(win, bounds.physical, saved || bounds, true, false)) throw new Error(`Handoff minimized restoration failed: ${session.id}`);
      stack();
      if (!minimized) win.showInactive();
      stack();
      opened = true;
    });
  }
  // Only save moves made after the window opened: re-applying saved bounds rounds by a
  // pixel or two on scaled monitors, and saving that would make windows creep.
  if (bounds.physical) win.physical = { ...bounds.physical };
  const remember = () => { if (!opened) return; saveBounds(session.id, win); };
  trackPhysical(win, remember);
  win.on('move', remember);
  win.on('resize', remember);
  win.on('maximize', () => fillWorkArea(win));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', (_e, d) => {
    log('error', 'renderer.gone', { id: session.id, reason: d.reason });
    if (!win.isDestroyed()) win.reload();
  });
  win.on('unresponsive', () => log('warn', 'renderer.unresponsive', { id: session.id }));
  win.created = Date.parse(session.created || '') || 0;
  win.blind = noDisplays();
  win.on('closed', () => {
    windows.delete(session.id);
    if (!quittingKeepSessions && !win.keepSession) {
      fs.writeFileSync(lastCloseFile, session.id);
    }
    log('info', 'window.close', { id: session.id, keptSession: true });
    panelSweep();
    quitIfEmpty();
  });
  win.webContents.on('did-finish-load', () => { if (pins.has(session.id)) win.webContents.send('pins', pins.get(session.id)); });
  win.webContents.on('did-finish-load', () => { if (panels.has(session.id)) sendPanel(session.id); });
  windows.set(session.id, win);
  for (const fn of windowHooks) {
    try { fn(session.id, win); } catch (e) { log('error', 'extras.window', { id: session.id, error: e.message }); }
  }
  log('info', 'window.open', { id: session.id, activate, place: offscreen ? 'offscreen' : saved ? 'saved' : fresh ? 'new' : savedBounds[session.id] ? 'offscreen' : 'unknown', physical: !!bounds.physical });
  return win;
}

function pageFrame(win) {
  return win.webContents.mainFrame.frames.find(frame => frame.name === 'r7-surface') || win.webContents.mainFrame;
}

// ---- undo close -------------------------------------------------------------
// Reopen the most recently closed session without ending windowless sessions.
const lastCloseFile = path.join(STATE, 'last-close');

async function reopenClosed() {
  let id = '';
  try { id = fs.readFileSync(lastCloseFile, 'utf8').trim(); } catch {}
  if (!id) return { reopened: null };
  const s = await api('GET', `/sessions/${id}`);
  openWindow(s, { activate: true });
  fs.rmSync(lastCloseFile, { force: true });
  log('info', 'window.reopen', { id });
  return { reopened: id };
}

function quitIfEmpty() {
  if (!windows.size && !quittingKeepSessions) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeJson(boundsFile, savedBounds); }
    app.quit();
  }
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
    if (control !== ws || handingOff) return;
    log('warn', 'control.closed', {});
    setTimeout(async () => { try { await ensureDaemon(); } catch {} connectControl(); }, 1000);
  };
  ws.onerror = () => {};
}

// ---- session panel -------------------------------------------------------------
// `r7shell panel`: app/panels.js.

const { panels, sendPanel, panelSet, panelRun, panelRender, panelsAdopt, panelTurnEnd, panelSweep } =
  require('./panels')({ windows, log, api, STATE, settings, shared, ipcMain });

async function handleCommand(cmd, a) {
  if (commands.has(cmd)) return commands.get(cmd)(a);
  if (cmd === 'open') {
    const s = await api('GET', `/sessions/${a.session}`);
    openWindow(s, { activate: !!a.activate && !a.offscreen, offscreen: !!a.offscreen });
    return { opened: s.id };
  }
  if (cmd === 'windows') {
    // `scaleOk` false means the page is laid out at the wrong scale (see reopenBlind):
    // its width in CSS pixels times its pixel ratio doesn't fill the window.
    return Promise.all([...windows.entries()].map(async ([id, w]) => {
      let page = null;
      try { page = await pageFrame(w).executeJavaScript("({ dpr: devicePixelRatio, cssWidth: innerWidth, fontPx: typeof term !== 'undefined' ? term.options.fontSize : null })"); } catch {}
      const fit = await w.webContents.executeJavaScript('window.r7CanvasFit || null').catch(() => null);
      const physicalWidth = w.physical?.width ?? (noDisplays() ? null : Math.round(w.getContentBounds().width * screen.getDisplayMatching(w.getBounds()).scaleFactor));
      const scaleOk = page && physicalWidth ? fit ? Math.abs(page.cssWidth - fit.width) < 2 && page.cssWidth * page.dpr * fit.scale <= physicalWidth + 4 : Math.abs(page.cssWidth * page.dpr - physicalWidth) < 4 : null;
      return { id, bounds: w.getBounds(), physical: w.physical || null, visible: w.isVisible(), focused: w.isFocused(), title: w.getTitle(), blind: !!w.blind, offscreen: !!w.testOffscreen, offscreenReady: !!w.offscreenReady, ...(page ? { dpr: page.dpr, fontPt: page.fontPx && Math.round(page.fontPx * 72 / 96 * 10) / 10 } : {}), ...(fit ? {fitScale:fit.scale} : {}), scaleOk };
    }));
  }
  if (cmd === 'shot') {
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : a.session === 'flash' && flashWin && !flashWin.isDestroyed() ? flashWin : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const img = await win.webContents.capturePage();
    const file = a.out || path.join(STATE, 'shots', `${a.session}-${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return { file, wsl: winToWsl(file), size: img.getSize() };
  }
  if (cmd === 'record') {
    // Every frame the window paints for `ms`, as numbered JPEGs in `dir` (half size unless
    // `scale` says otherwise), for concept and motion videos at their real frame rate.
    const win = windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    fs.mkdirSync(a.dir, { recursive: true });
    const scale = a.scale || 0.5;
    if (a.step) {
      // Exact frames: the page's virtual clock (test shell r7Clock) steps 1/fps per frame, so
      // the video is smooth however slow capturing is. `rect` captures only that part.
      const fps = a.fps || 60;
      const count = Math.round((a.ms || 3000) * fps / 1000);
      const js = (code) => pageFrame(win).executeJavaScript(code, true);
      if (!(await js('!!window.r7Clock'))) throw new Error('record --step: page has no r7Clock (test shell only)');
      await js('window.r7Clock.freeze(), 1');
      try {
        for (let i = 0; i < count; i++) {
          await js(`window.r7Clock.step(${1000 / fps})`);
          const image = await win.webContents.capturePage(a.rect || undefined);
          const size = image.getSize();
          const small = scale === 1 ? image : image.resize({ width: Math.round(size.width * scale), quality: 'good' });
          fs.writeFileSync(path.join(a.dir, `${String(i).padStart(4, '0')}.jpg`), small.toJPEG(92));
        }
      } finally { await js('window.r7Clock.thaw(), 1'); }
      log('info', 'record', { id: a.session, frames: count, fps, step: true });
      return { frames: count, times: Array.from({ length: count }, (_, i) => Math.round(i * 1000 / fps)) };
    }
    const times = [];
    const t0 = Date.now();
    let n = 0;
    win.webContents.beginFrameSubscription(false, (image) => {
      const size = image.getSize();
      const small = scale === 1 ? image : image.resize({ width: Math.round(size.width * scale), quality: 'good' });
      fs.writeFile(path.join(a.dir, `${String(n).padStart(4, '0')}.jpg`), small.toJPEG(90), () => {});
      times.push(Date.now() - t0);
      n++;
    });
    // A still page paints nothing: nudge one paint so even a quiet window gives frames.
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, a.ms || 3000));
    win.webContents.endFrameSubscription();
    log('info', 'record', { id: a.session, frames: n, ms: a.ms || 3000 });
    return { frames: n, times };
  }
  if (cmd === 'key') {
    // A key press inside this app's own window (no desktop input), for testing
    // the window's own shortcuts. `send` is the way to type into the program.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const modifiers = a.modifiers || [];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode, modifiers });
    if (a.keyCode.length === 1 && !modifiers.some((m) => m === 'control' || m === 'alt')) win.webContents.sendInputEvent({ type: 'char', keyCode: a.keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode, modifiers });
    return { sent: a.keyCode, modifiers };
  }
  if (cmd === 'js') {
    // Runs a line of JavaScript in one window's page, for tests.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : a.session === 'flash' && flashWin && !flashWin.isDestroyed() ? flashWin : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    return { result: await pageFrame(win).executeJavaScript(String(a.code)) };
  }
  if (cmd === 'done') {
    // A program's turn finished: the window flashes until it's focused.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    panelTurnEnd(a.session);
    win.webContents.send('done');
    return { done: a.session };
  }
  if (cmd === 'pin') {
    // `r7shell pin`: one entry of 1-8 images or videos, newest first, or --clear.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const list = a.clear ? [] : [{ id: `pin-${Date.now()}`, media: a.media || [] }, ...(pins.get(a.session) || [])];
    pins.set(a.session, list);
    win.webContents.send('pins', list);
    return { entries: list.length };
  }
  if (cmd === 'panel') {
    if (a.press) return panelRun(String(a.session), String(a.press), 'cli');
    if (a.render) return panelRender(String(a.session), String(a.render));
    return panelSet(a);
  }
  if (cmd === 'attention-test') {
    // Shows a made-up turn state in one window (glow, pins) until the next real update.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const data = { phase: '', completedMs: 0, seen: false, ...a.data };
    if (data.completedMs === 'now') data.completedMs = Date.now();
    const pinsCall = data.pins ? `r7shell.setPins(${JSON.stringify(data.pins)});` : '';
    await pageFrame(win).executeJavaScript(`r7shell.attention(${JSON.stringify(data)});${pinsCall}`);
    return { sent: { ...data, pins: data.pins?.length || 0 } };
  }
  if (cmd === 'hover') {
    // Moves the pointer inside this app's own window (no desktop input), for testing links.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
    return { x: a.x, y: a.y };
  }
  if (cmd === 'click') {
    // A left click inside this app's own window (no desktop input), for testing links.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    const at = { x: a.x, y: a.y, modifiers: a.ctrl ? ['control'] : [] };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
    await new Promise((r) => setTimeout(r, 60));
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at });
    return { x: a.x, y: a.y };
  }
  if (cmd === 'drag') {
    // A left-button drag inside this app's own window, for testing selection.
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
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
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    if (win.testOffscreen) throw new Error('Offscreen test windows require native physical placement, not drag-resize');
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
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
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
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (!win) throw new Error(`no window for "${a.session}"`);
    let b = a.bounds;
    if (a.display != null) {
      const d = screen.getAllDisplays()[a.display];
      if (!d) throw new Error(`no display ${a.display}`);
      const w = d.workArea;
      b = { x: w.x + Math.round(w.width * 0.1), y: w.y + Math.round(w.height * 0.1), width: Math.round(w.width * 0.8), height: Math.round(w.height * 0.8) };
    }
    // Moving onto a monitor with a different scale resizes by the scale change, so the
    // size is set again once the window is there.
    win.setBounds(b);
    win.setBounds(b);
    return win.getBounds();
  }
  if (cmd === 'reload') {
    for (const [id, w] of windows) if (!a.session || a.session === id) w.webContents.reloadIgnoringCache();
    return { reloaded: a.session || 'all' };
  }
  if (cmd === 'close') {
    const win = a.session === 'viewer' && viewer && !viewer.isDestroyed() ? viewer : windows.get(a.session);
    if (win) setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 50);
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
  if (cmd === 'restart') return restartHandoff();
  if (cmd === 'stats') {
    return { version: VERSION, gpu: GPU, windows: windows.size, metrics: app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpu: m.cpu.percentCPUUsage, memMB: Math.round(m.memory.workingSetSize / 1024) })) };
  }
  throw new Error(`unknown command "${cmd}"`);
}

// ---- restart handoff ----------------------------------------------------------
// Replace windows only after the new app has redrawn them and restored focus.
const handoffFile = path.join(STATE, 'handoff.json');
const HANDOFF_DRAW_MS = 350;
let handingOff = false;
const hwndOf = (w) => w.getNativeWindowHandle().readBigUInt64LE(0).toString();

function validPhysical(p) {
  return !!p && [p.x, p.y, p.width, p.height].every(Number.isInteger) && p.width > 0 && p.height > 0;
}

function validHwnd(hwnd) {
  return typeof hwnd === 'string' && /^[1-9][0-9]{0,18}$/.test(hwnd) && BigInt(hwnd) <= 9223372036854775807n;
}

function captureHandoff(entries) {
  if (!entries.length) return Promise.resolve({});
  if (entries.some((e) => !validHwnd(e.hwnd))) return Promise.reject(new Error('Missing or invalid handoff HWND'));
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class Capture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct PLACEMENT { public int Length, Flags, Show; public POINT Min, Max; public RECT Normal; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref RECT r, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO m);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT p);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static int[] Rect(IntPtr h, bool normal) {
    RECT r;
    if (normal) {
      PLACEMENT p = new PLACEMENT { Length=Marshal.SizeOf(typeof(PLACEMENT)) };
      if (!GetWindowPlacement(h, ref p)) throw new Win32Exception(Marshal.GetLastWin32Error());
      r = p.Normal;
      // WINDOWPLACEMENT uses workspace coordinates except for tool windows.
      if ((GetWindowLong(h, -20) & 0x80) == 0) {
        MONITORINFO m = new MONITORINFO { Size=Marshal.SizeOf(typeof(MONITORINFO)) };
        if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref m)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int dx = m.Work.Left-m.Monitor.Left, dy = m.Work.Top-m.Monitor.Top;
        r.Left += dx; r.Right += dx; r.Top += dy; r.Bottom += dy;
      }
    } else if (IsZoomed(h)) {
      // A maximized window's rect hangs past the monitor by the frame width; the
      // replacement opens unmaximized on the work area it was covering.
      MONITORINFO m = new MONITORINFO { Size=Marshal.SizeOf(typeof(MONITORINFO)) };
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref m)) throw new Win32Exception(Marshal.GetLastWin32Error());
      r = m.Work;
    } else if (!GetWindowRect(h, out r)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return new int[] { r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top };
  }
  public static bool OnScreen(int[] r) {
    RECT rect = new RECT { Left=r[0], Top=r[1], Right=checked(r[0]+r[2]), Bottom=checked(r[1]+r[3]) };
    return MonitorFromRect(ref rect, 0) != IntPtr.Zero;
  }
}
'@
if ([Capture]::SetThreadDpiAwarenessContext([IntPtr]-4) -eq [IntPtr]::Zero) { throw 'SetThreadDpiAwarenessContext(-4) failed' }
ConvertTo-Json -Compress -InputObject @(${entries.map((e) => `$min = [Capture]::IsIconic([IntPtr]${e.hwnd}); $rect = [Capture]::Rect([IntPtr]${e.hwnd}, $min); @{ hwnd='${e.hwnd}'; rect=$rect; minimized=$min; onScreen=[Capture]::OnScreen($rect) }`).join('; ')})
`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (err, stdout, stderr) => {
      try {
        if (err) throw new Error(String(stderr || err.message).trim());
        const rows = JSON.parse(stdout);
        if (!Array.isArray(rows) || rows.length !== entries.length) throw new Error('Missing native handoff rectangles');
        const captured = {};
        entries.forEach((e, i) => {
          const row = rows[i];
          const [x, y, width, height] = row.rect || [];
          const actual = { x, y, width, height };
          if (row.hwnd !== e.hwnd || !validPhysical(actual) || (e.win && (e.win.isDestroyed() || hwndOf(e.win) !== e.hwnd))) throw new Error(`Invalid native handoff rectangle: ${e.id}`);
          if (typeof row.minimized !== 'boolean' || typeof row.onScreen !== 'boolean') throw new Error(`Missing native handoff disposition: ${e.id}`);
          if (!row.onScreen) {
            log('info', 'handoff.offscreen', { id: e.id, hwnd: e.hwnd, physical: actual });
            return;
          }
          // Fullscreen covers the display, not the normal rectangle to return to.
          const minimized = row.minimized;
          const physical = e.fullscreen ? savedBounds[e.id]?.physical : actual;
          if (!validPhysical(physical)) throw new Error(`Missing normal handoff rectangle: ${e.id}`);
          captured[e.id] = { physical, minimized: !!minimized, fullscreen: !!e.fullscreen };
        });
        resolve(captured);
      } catch (e) { reject(e); }
    });
  });
}

async function restartHandoff() {
  if (handingOff) return { restarting: true };
  handingOff = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const entries = [...windows].filter(([, w]) => !w.isDestroyed() && !w.testOffscreen).map(([id, win]) => ({ id, win, hwnd: hwndOf(win), minimized: win.isMinimized(), fullscreen: win.isFullScreen() }));
  let geometry;
  try {
    geometry = await captureHandoff(entries);
    for (const e of entries) {
      if (geometry[e.id] && !e.minimized && !e.fullscreen) savedBounds[e.id] = { ...e.win.getBounds(), physical: geometry[e.id].physical };
    }
    writeJson(boundsFile, savedBounds);
  } catch (e) {
    handingOff = false;
    log('error', 'app.handoff', { phase: 'capture_failed', error: e.message });
    return { restarting: false, error: e.message };
  }
  if (storeTimer) saveStore();
  const focusedWin = BrowserWindow.getFocusedWindow();
  const hwnds = {};
  let focused = null;
  for (const { id, win: w, hwnd } of entries) {
    if (!geometry[id]) continue;
    hwnds[id] = hwnd;
    if (w === focusedWin) focused = id;
  }
  writeJson(reopenFile, { at: Date.now(), ids: Object.keys(hwnds), hwnds, geometry, focused });
  fs.rmSync(handoffFile, { force: true });
  app.releaseSingleInstanceLock();
  // Started by this app, which has the foreground if a terminal is focused, so the new
  // app may hand focus back to it.
  const child = spawn(process.execPath, [app.getAppPath(), '--inactive', '--handoff'], { detached: true, stdio: 'ignore' });
  child.unref();
  const started = Date.now();
  log('info', 'app.handoff', { phase: 'start', pid: child.pid, windows: Object.keys(hwnds).length, focused });
  // A new copy that dies (a broken main.js) leaves this one running as it was.
  let died = false;
  let exitCode = null;
  let childError = '';
  child.once('exit', (code) => { died = true; exitCode = code; });
  child.once('error', (e) => { died = true; childError = e.message; });
  const timer = setInterval(async () => {
    const ready = !died && readJson(handoffFile, null)?.pid === child.pid;
    if (!died && !ready && Date.now() - started < 30000) return;
    clearInterval(timer);
    if (!ready) {
      const phase = died ? 'failed' : 'timeout';
      let stopped = died;
      if (!died) {
        stopped = await new Promise((resolve) => {
          const done = (ok) => { clearTimeout(t); child.removeListener('exit', exited); resolve(ok); };
          const exited = () => done(true);
          const t = setTimeout(() => done(false), 5000);
          child.once('exit', exited);
          try { if (!child.kill()) done(died); }
          catch (e) { childError = e.message; done(died); }
        });
      }
      const locked = app.requestSingleInstanceLock();
      if (locked) writeJson(slotFile, { slot });
      handingOff = false;
      const previous = control;
      control = null;
      previous?.close();
      connectControl();
      log(stopped && locked ? 'warn' : 'error', 'app.handoff', { phase, pid: child.pid, ms: Date.now() - started, keptWindows: windows.size, stopped, locked, code: exitCode, ...(childError ? { error: childError } : {}) });
      return;
    }
    log('info', 'app.handoff', { phase: 'done', ms: Date.now() - started });
    quittingKeepSessions = true;
    // The new app usually can't take focus itself (Windows refuses once you've typed since
    // it started). Closing the focused window passes focus to the next window below it, so
    // the old one goes right above its replacement and closes first.
    const next = ready && focused && readJson(handoffFile, null)?.hwnd;
    const old = focused && windows.get(focused);
    if (next && old && !old.isDestroyed() && old.isFocused()) {
      try { old.moveAbove(`window:${next}:0`); } catch (e) { log('warn', 'handoff.zorder', { id: focused, error: e.message }); }
      old.destroy();
    }
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    app.quit();
  }, 30);
  return { restarting: true, pid: child.pid };
}

// New app, started with --handoff: once every reopened window shows, focus goes back
// to the one that had it and the old app is told to close.
async function finishHandoff(wins, focused) {
  await Promise.all(wins.map((w) => w.shown).filter(Boolean));
  const win = focused && windows.get(focused);
  const live = win && !win.isDestroyed() && !win.isMinimized();
  if (live) {
    win.focus();
    setTimeout(() => { if (!win.isDestroyed()) log('info', 'handoff.focus', { id: focused, focused: win.isFocused() }); }, 1500);
  }
  writeJson(handoffFile, { pid: process.pid, at: Date.now(), focused: focused || null, hwnd: live ? hwndOf(win) : null });
  log('info', 'app.handoff', { phase: 'shown', windows: wins.length, focused: focused || null });
}

function failHandoff(error, phase) {
  quittingKeepSessions = true;
  try { writeJson(slotFile, { slot: lastSlot }); }
  finally {
    try { log('error', 'handoff.error', { phase, error: error.message }); }
    finally { app.exit(1); }
  }
}

async function openHandoff(sessions, handoff) {
  let phase = 'capture_old';
  quittingKeepSessions = true;
  try {
    if (!handoff?.hwnds) throw new Error('Missing handoff window map');
    const entries = sessions.map((s) => ({ id: s.id, hwnd: handoff.hwnds[s.id] }));
    if (entries.some((e) => !validHwnd(e.hwnd))) throw new Error('Missing or invalid handoff HWND');
    // Older copies have no geometry payload; sample their still-live HWNDs first.
    if (!handoff.geometry) handoff.geometry = await captureHandoff(entries);
    else if (entries.some((e) => !validPhysical(handoff.geometry[e.id]?.physical))) throw new Error('Missing handoff physical rect');
    phase = 'open';
    const opened = sessions.filter((s) => handoff.geometry[s.id]).map((s) =>
      openWindow(s, { activate: false, above: handoff.hwnds[s.id], ...handoff.geometry[s.id] })).filter(Boolean);
    phase = 'shown';
    await finishHandoff(opened, handoff.focused);
    quittingKeepSessions = false;
    return true;
  } catch (e) {
    failHandoff(e, phase);
    return false;
  }
}

const attachWaiters = new Map(); // webContents id -> resolve
function waitAttach(win) {
  const id = win.webContents.id;
  return new Promise((resolve) => {
    const done = () => { attachWaiters.delete(id); clearTimeout(t); resolve(); };
    const t = setTimeout(done, 4000);
    attachWaiters.set(id, () => setTimeout(done, HANDOFF_DRAW_MS));
  });
}

async function quitKeepingSessions() {
  quittingKeepSessions = true;
  if (saveTimer) { clearTimeout(saveTimer); writeJson(boundsFile, savedBounds); }
  // The next start reopens only these: sessions run without a window (`new --no-open`,
  // `close`) stay windowless instead of popping up on screen.
  writeJson(reopenFile, { at: Date.now(), ids: [...windows.keys()] });
  log('info', 'app.quit', { keepSessions: true });
  app.quit();
}
const reopenFile = path.join(STATE, 'reopen-windows.json');

// ---- renderer IPC ------------------------------------------------------------

ipcMain.handle('clipboard:read', () => clipboard.readText());
// Save clipboard pictures where the session can read them before handling Ctrl+V.
ipcMain.handle('clipboard:image', async (event, session) => {
  if (!/^[\w.-]+$/.test(String(session))) return false;
  const file = path.join(STATE, 'paste', `${session}.png`);
  const start = performance.now();
  const image = clipboard.readImage();
  if (image.isEmpty()) return false;
  const captured = performance.now();
  const { bytes, width, height, encoder, encodeMs, writeMs } = await saveImage(image, file);
  log('info', 'clipboard.image', {
    session, width, height, bytes: bytes.length, encoder,
    readMs: Math.round(captured - start), encodeMs, writeMs,
  });
  return true;
});
// Capture the window so a refresh can hold it still during a restart.
ipcMain.handle('window:snapshot', async (event, rect) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return (await win.webContents.capturePage(rect || undefined)).toDataURL();
});
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
ipcMain.on('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('path:check', (_e, p, cwd, home) => checkPath(p, cwd, home));
// A picture's modified time, added to its file URL so a file written again shows its
// new contents instead of Chromium's cached copy of the same URL.
ipcMain.handle('file:version', async (_e, p) => {
  const win = await checkPath(p, '', '');
  if (!win) return 0;
  try { return Math.round((await fs.promises.stat(win)).mtimeMs); } catch { return 0; }
});
// A picture shown in a window (tool screenshot), saved so the viewer can open it full size.
ipcMain.on('image:open', (e, dataUrl) => {
  const file = shared.savePicture(dataUrl);
  if (file) openViewer(file, BrowserWindow.fromWebContents(e.sender));
});
ipcMain.on('path:open', (e, win) => {
  win = String(win);
  if (IMAGE_RE.test(win) && fs.existsSync(win)) return openViewer(win, BrowserWindow.fromWebContents(e.sender));
  shell.openPath(win).then((err) => { if (err) log('warn', 'path.open', { path: win, error: err }); });
});
// Pages' saved values (preload.js `store`), one file for every copy of the app.
const storeFile = path.join(STATE, 'page-store.json');
// Both copies run for a moment during a restart, so a save writes only the keys this
// copy changed over what's in the file now.
const pageStore = readJson(storeFile, {});
const storeChanged = new Set();
let storeTimer = 0;
function saveStore() {
  clearTimeout(storeTimer);
  storeTimer = 0;
  const file = readJson(storeFile, {});
  for (const key of storeChanged) {
    if (pageStore[key] == null) delete file[key];
    else file[key] = pageStore[key];
  }
  storeChanged.clear();
  writeJson(storeFile, file);
}
ipcMain.on('store:get', (e, key) => { e.returnValue = pageStore[key] ?? null; });
ipcMain.on('store:set', (e, key, value) => {
  const next = value == null ? null : String(value);
  // Same value: only the sender needs its acknowledgement (preload counts them).
  if ((pageStore[key] ?? null) === next) {
    if (!e.sender.isDestroyed()) e.sender.send('store:changed', key, next, true);
    return;
  }
  if (value == null) delete pageStore[key];
  else pageStore[key] = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('store:changed', key, pageStore[key] ?? null, win.webContents === e.sender);
  }
  storeChanged.add(key);
  clearTimeout(storeTimer);
  storeTimer = setTimeout(saveStore, 500);
});
app.on('will-quit', () => { if (storeTimer) saveStore(); });

ipcMain.on('log', (e, lvl, ev, data) => {
  if (ev === 'attach') attachWaiters.get(e.sender.id)?.();
  log(lvl, ev, { from: 'renderer', ...data });
});
ipcMain.on('set-title', (e, title) => BrowserWindow.fromWebContents(e.sender)?.setTitle(String(title)));
ipcMain.on('close-window', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('turn-end', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win?.sessionId) panelTurnEnd(win.sessionId);
});

// Finish flash: when a reply finishes in a window that isn't focused, a bottom glow
// flashes along that window's bottom edge in a small always-on-top, click-through
// window, so it shows even with a game or another app over the terminal. It flashes
// three times, 0.8s each, and repeats every 30s until the window is focused.
const FLASH_REPEAT_MS = 30000;
const FLASH_HEIGHT = 192;
const flashTimers = new Map(); // BrowserWindow id -> timer
let flashWin = null;
let flashReady = null;
let flashHide = 0;

function getFlashWin() {
  if (flashWin && !flashWin.isDestroyed()) return flashReady;
  flashWin = new BrowserWindow({
    width: 400, height: FLASH_HEIGHT, show: false, frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  flashWin.setIgnoreMouseEvents(true);
  flashWin.setAlwaysOnTop(true, 'screen-saver');
  flashWin.hookWindowMessage(0x0003, (_w, l) => { flashWin.physical = { ...flashWin.physical, x: l.readInt16LE(0), y: l.readInt16LE(2) }; });
  flashWin.hookWindowMessage(0x0005, (_w, l) => { flashWin.physical = { ...flashWin.physical, width: l.readUInt16LE(0), height: l.readUInt16LE(2) }; });
  flashReady = flashWin.loadFile(path.join(__dirname, 'flash.html'));
  return flashReady;
}

async function flashUnder(win, first) {
  if (win.isDestroyed()) return;
  await getFlashWin();
  if (win.isDestroyed() || win.isFocused()) return;
  // A minimized window flashes where it comes back to.
  const minimized = win.isMinimized();
  const b = minimized ? win.getNormalBounds() : win.getBounds();
  // The flash window covers the terminal (the glow at its bottom, the square in its
  // middle). DIP bounds land a pixel or two off on scaled monitors, so it is a little
  // larger and the page lays out on the terminal's exact pixel edges (its own pixel
  // rect against the terminal's, both from WM_MOVE/WM_SIZE).
  const pad = 2;
  flashWin.setBounds({ x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 });
  flashWin.setAlwaysOnTop(true, 'screen-saver');
  flashWin.showInactive();
  flashWin.moveTop();
  flashOwner = win.id;
  await new Promise((r) => setTimeout(r, 0));
  if (flashOwner !== win.id) return;
  const t = !minimized && win.physical;
  const f = flashWin.physical;
  const edges = t?.width && f?.width
    ? { device: true, left: t.x - f.x, top: t.y - f.y, right: f.x + f.width - (t.x + t.width), bottom: f.y + f.height - (t.y + t.height) }
    : { device: false, left: pad, top: pad, right: pad, bottom: pad };
  flashWin.webContents.executeJavaScript(`play(${JSON.stringify(win.flashColor || '#ff4fb8')}, ${JSON.stringify(edges)}, ${!!first})`).catch(() => {});
  clearTimeout(flashHide);
  flashHide = setTimeout(() => { flashOwner = 0; if (!flashWin.isDestroyed()) flashWin.hide(); }, 2700);
  const id = [...windows].find(([, w]) => w === win)?.[0] || '';
  log('info', 'flash', { id, first: !!first, at: b, physical: t || null, flashPhysical: f || null, edges });
}

// Activating the terminal ends its flashing at once, the one on screen included,
// and no reminder comes back for that finish.
let flashOwner = 0;
function stopFlash(wid) {
  clearTimeout(flashTimers.get(wid));
  flashTimers.delete(wid);
  if (flashOwner !== wid || !flashWin || flashWin.isDestroyed()) return;
  flashOwner = 0;
  clearTimeout(flashHide);
  flashWin.webContents.executeJavaScript('stop()').catch(() => {});
  flashWin.hide();
}

ipcMain.on('finish-flash', (e, on, completedMs, color) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.testOffscreen) return stopFlash(win.id);
  if (color) win.flashColor = String(color);
  if (!win.flashHooked) {
    win.flashHooked = true;
    const wid = win.id;
    win.on('focus', () => stopFlash(wid));
    win.once('closed', () => stopFlash(wid));
  }
  if (!on || win.isFocused()) return stopFlash(win.id);
  clearTimeout(flashTimers.get(win.id));
  flashTimers.delete(win.id);
  // Keep to the reminder rhythm from when the reply finished, so a reload or app
  // restart doesn't flash an old finish again straight away.
  const elapsed = Math.max(0, Date.now() - (Number(completedMs) || Date.now()));
  // One finish can reach the page as two updates a moment apart, which flashed twice.
  const justFlashed = Date.now() - (win.lastFlashAt || 0) < 10000;
  const wait = elapsed < 10000 && !justFlashed ? 0 : FLASH_REPEAT_MS - (elapsed % FLASH_REPEAT_MS);
  // The square shows with the finish's own flash, not the reminders.
  let first = wait === 0;
  const run = () => {
    if (win.isDestroyed()) return;
    win.lastFlashAt = Date.now();
    flashTimers.set(win.id, setTimeout(run, FLASH_REPEAT_MS));
    flashUnder(win, first).catch((err) => log('warn', 'flash.error', { error: err.message }));
    first = false;
  };
  flashTimers.set(win.id, setTimeout(run, wait));
});
ipcMain.on('fullscreen', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.fullscreenPending) return;
  if (w.isFullScreen()) { w.setFullScreen(false); return; }
  w.fullscreenPending = true;
  try {
    // A new, unmoved window may never have produced a saved normal rectangle.
    let physical = w.physical;
    if (!validPhysical(physical)) {
      const captured = await captureHandoff([{ id: w.sessionId, win: w, hwnd: hwndOf(w), fullscreen: false }]);
      physical = captured[w.sessionId]?.physical;
    }
    if (w.isDestroyed() || !validPhysical(physical)) return;
    savedBounds[w.sessionId] = { ...w.getBounds(), physical: { ...physical } };
    writeJson(boundsFile, savedBounds);
    w.setFullScreen(true);
  } catch (error) {
    log('error', 'window.fullscreen', { id: w.sessionId, error: error.message });
  } finally { w.fullscreenPending = false; }
});
ipcMain.on('new-window', (_e, template) => newSession(template).catch((err) => log('error', 'new.error', { error: err.message })));
// A window laid out at the wrong scale (opened without monitors) looks zoomed out, and
// zooming it to compensate once saved a size that made every new window huge.
ipcMain.on('font-size', (e, template, size) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win?.blind || win?.testOffscreen) return log('info', 'font.save_skipped', { template, size, why: win.testOffscreen ? 'test window' : 'blind window' });
  settings.fontSizes = shared.saveFontSize(template, size);
});
ipcMain.on('zoom', (e, template, kind, value) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win?.blind || win?.testOffscreen) return log('info', 'zoom.save_skipped', { template, kind, value, why: win.testOffscreen ? 'test window' : 'blind window' });
  if (!['page', 'title'].includes(kind) || !(value > 0)) return log('warn', 'zoom.bad', { template, kind, value });
  settings.zooms = shared.saveZoom(template, kind, value);
});

function checkPath(p, cwd, home) {
  return shared.checkPath(p, cwd, home, settings.distro);
}

// ---- picture viewer ------------------------------------------------------------
// Pictures fit within 85% of the terminal's screen, scaled up at most 2x.

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i;
let viewer = null;

function openViewer(file, from) {
  const display = screen.getDisplayMatching((from && !from.isDestroyed() ? from : BrowserWindow.getFocusedWindow())?.getBounds() || screen.getPrimaryDisplay().bounds);
  const area = display.workArea;
  const size = nativeImage.createFromPath(file).getSize();
  // In screen pixels: a 2560x1440 shot on a 150% monitor is 1707x960 window units at 1:1.
  const scale = display.scaleFactor || 1;
  const px = { width: size.width || 1200, height: size.height || 800 };
  const fit = Math.min(2, (area.width * scale * 0.85) / px.width, (area.height * scale * 0.85) / px.height);
  const width = Math.round(Math.max(480, (px.width * fit) / scale));
  const height = Math.round(Math.max(360, (px.height * fit) / scale));
  const bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
  // Activate only when opened from the focused window.
  const activate = !!from && !from.isDestroyed() && from.isFocused();
  if (!viewer || viewer.isDestroyed()) {
    viewer = new BrowserWindow({
      ...bounds, minWidth: 240, minHeight: 160, show: false, frame: false, thickFrame: true, backgroundColor: '#0b0b10',
      autoHideMenuBar: true, icon: path.join(ROOT, 'app', 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'viewer', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    viewer.setMenu(null);
    viewer.webContents.on('will-navigate', (ev) => ev.preventDefault());
    viewer.once('ready-to-show', () => (activate ? viewer.show() : viewer.showInactive()));
  } else {
    if (viewer.isFullScreen()) viewer.setFullScreen(false);
    if (activate) viewer.focus();
  }
  viewer.setBounds(bounds);
  viewer.file = file;
  viewer.setTitle(path.basename(file));
  viewer.loadFile(path.join(__dirname, 'viewer', 'viewer.html'), { query: { src: pathToFileURL(file).href, name: path.basename(file) } });
  log('info', 'viewer.open', { file, image: `${size.width}x${size.height}`, activate });
}

ipcMain.on('viewer:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('viewer:fullscreen', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.on('viewer:folder', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w?.file) shell.showItemInFolder(w.file); });
ipcMain.on('viewer:menu', (e, x, y) => { const w = BrowserWindow.fromWebContents(e.sender); if (w?.file) pictureMenu(w.file, w, x, y); });

// ---- right-click on a picture --------------------------------------------------
// Reply pictures, tool screenshots, pins and the viewer share one menu.

// Copy puts the file and the picture on the clipboard together: Discord and Explorer
// paste the file (a GIF stays animated), image apps paste the picture.
const COPY_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$p = $env:R7_PIC
$data = New-Object System.Windows.Forms.DataObject
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($p)
$data.SetFileDropList($files)
if ($p -match '\\.(png|jpe?g|gif|bmp)$') {
  $bytes = [IO.File]::ReadAllBytes($p)
  $data.SetImage([System.Drawing.Image]::FromStream((New-Object IO.MemoryStream(,$bytes))))
  if ($p -match '\\.png$') { $data.SetData('PNG', (New-Object IO.MemoryStream(,$bytes))) }
}
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
`;

function copyPicture(file) {
  const encoded = Buffer.from(COPY_SCRIPT, 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
    { windowsHide: true, env: { ...process.env, R7_PIC: file } },
    (err) => log(err ? 'warn' : 'info', 'picture.copy', { file, error: err?.message }));
}

// Save as starts in the folder used last time.
const saveFolderFile = path.join(STATE, 'save-folder.json');
async function savePictureAs(file, win) {
  const folder = readJson(saveFolderFile, {}).folder || app.getPath('pictures');
  const ext = path.extname(file).slice(1).toLowerCase();
  const result = await dialog.showSaveDialog(win, {
    defaultPath: path.join(folder, path.basename(file)),
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
  });
  if (result.canceled || !result.filePath) return;
  try {
    await fs.promises.copyFile(file, result.filePath);
    writeJson(saveFolderFile, { folder: path.dirname(result.filePath) });
    log('info', 'picture.save', { file, to: result.filePath });
  } catch (err) {
    log('warn', 'picture.save', { file, to: result.filePath, error: err.message });
  }
}

function pictureMenu(file, win, x, y) {
  if (!file || !fs.existsSync(file) || !win || win.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: IMAGE_RE.test(file) ? 'Copy image' : 'Copy file', click: () => copyPicture(file) },
    { label: 'Save as…', click: () => savePictureAs(file, win) },
    { type: 'separator' },
    { label: 'Show in folder', click: () => shell.showItemInFolder(file) },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

// From a terminal window: { path } for a file, or { dataUrl } for a drawn screenshot.
ipcMain.on('picture:menu', (e, target, x, y) => {
  const file = target?.dataUrl ? shared.savePicture(target.dataUrl) : String(target?.path || '');
  pictureMenu(file, BrowserWindow.fromWebContents(e.sender), x, y);
});

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
  // Launching r7-Shell again opens another window with the default template.
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
      if (flag('--handoff')) { failHandoff(e, 'daemon'); return; }
      const { dialog } = require('electron');
      dialog.showErrorBox('r7-Shell', `The session daemon didn't start.\n${e.message}\nLog: ${STATE}\\logs`);
      app.quit();
      return;
    }
    connectControl();
    await panelsAdopt().catch((e) => log('error', 'panel.adopt', { error: e.message }));
    loadExtras();
    screen.on('display-added', displaysChanged);
    screen.on('display-removed', displaysChanged);
    await waitForDisplays(20000);
    const activate = !flag('--inactive');
    const live = (await api('GET', '/sessions')).filter((s) => !embedded(s));
    let sessions = live;
    let reopen = null;
    try { reopen = JSON.parse(fs.readFileSync(reopenFile, 'utf8')); } catch {}
    fs.rmSync(reopenFile, { force: true });
    if (reopen && Date.now() - reopen.at < 120000) sessions = sessions.filter((s) => reopen.ids.includes(s.id));
    if (flag('--reopen')) {
      let id = '';
      try { id = fs.readFileSync(lastCloseFile, 'utf8').trim(); } catch {}
      sessions = live.filter((s) => s.id === id);
      fs.rmSync(lastCloseFile, { force: true });
    }
    const handoff = flag('--handoff') && reopen?.hwnds ? reopen : null;
    if (flag('--handoff')) {
      if (!await openHandoff(sessions, handoff)) return;
    } else sessions.forEach((s) => openWindow(s, { activate }));
    if (argv.some((x) => x === '--new' || x.startsWith('--new='))) await handleArgs(argv);
    else if (!live.length && !argv.includes('--reopen')) await newSession(settings.defaultTemplate, { activate });
    // `--reopen` with nothing to bring back opens no window, so quit.
    quitIfEmpty();
  }).catch((e) => {
    if (flag('--handoff')) failHandoff(e, 'startup');
    else log('error', 'app.start_failed', { error: e.message });
  });
}
