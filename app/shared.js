'use strict';
// Settings, the daemon, window config, paths and logs for the r7-Shell app.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
const STATE = path.join(process.env.LOCALAPPDATA, 'r7shell');
fs.mkdirSync(path.join(STATE, 'logs'), { recursive: true });
fs.mkdirSync(path.join(STATE, 'shots'), { recursive: true });

const DEFAULTS = {
  port: 47890,
  gpu: true,
  // The WSL distro and node the daemon runs with (install.sh writes both; the daemon
  // reports its distro on every start).
  distro: '',
  node: '',
  defaultTemplate: 'bash',
  font: { family: 'Cascadia Mono', size: 13 },
  // Size of every new window, centered on the primary monitor.
  newWindowSize: { width: 1082, height: 1073 },
  padding: 18,
  scrollSpeed: 1.5,
  scrollEaseMs: 45,
  cursorGlideMs: 60,
  // The page-drawn cursor: shape auto (what the program asks for), block, bar, underline
  // or outline; bar and underline thickness in px; blinkMs is each on/off half (0 = no blink).
  cursor: { shape: 'auto', width: 2, blinkMs: 331 },
  // New text fades in over this many ms (0 = off).
  fadeMs: 150,
  scrollback: 10000,
  // A folder of your own additions: templates/, themes/, renderer/*.css|js, main.js,
  // and a settings.json whose keys become defaults here.
  extras: '',
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

const settingsFile = path.join(STATE, 'settings.json');
function readSettings() {
  if (!fs.existsSync(settingsFile)) writeJson(settingsFile, DEFAULTS);
  const own = readJson(settingsFile, {});
  const dir = extrasDir(own);
  const extra = dir ? readJson(path.join(dir, 'settings.json'), {}) : {};
  return { ...DEFAULTS, ...extra, ...own };
}

// Merged with what's on disk, so a size saved from one window doesn't drop the others.
function saveFontSize(template, size) {
  const fontSizes = { ...(readJson(settingsFile, {}).fontSizes || {}), [template]: size };
  writeJson(settingsFile, { ...readJson(settingsFile, {}), fontSizes });
  return fontSizes;
}

// One JSONL log per host in logs/ (`r7shell log <name>`), rotated at 5MB.
function makeLog(name) {
  const file = path.join(STATE, 'logs', `${name}.jsonl`);
  return function log(lvl, ev, data = {}) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
        for (let i = 2; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), lvl, ev, ...data }) + '\n');
    } catch {}
  };
}

// ---- daemon ----------------------------------------------------------------

const token = () => { try { return fs.readFileSync(path.join(STATE, 'token'), 'utf8').trim(); } catch { return ''; } };

function api(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 4000,
      headers: { 'x-r7shell-token': token(), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch {}
        res.statusCode < 300 ? resolve(json) : reject(new Error(json.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('daemon timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function winToWsl(p) {
  return p
    .replace(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+/i, '')
    .replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

function wslToWin(p) {
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}` : p;
}

// The extras folder from settings (C:\... or /mnt/c/... form), or ''.
function extrasDir(settings = readJson(settingsFile, {})) {
  return settings.extras ? wslToWin(String(settings.extras)) : '';
}

// The daemon reports the distro it runs in; later launches use it.
function rememberDistro(settings, health) {
  if (!health?.distro || settings.distro === health.distro) return;
  settings.distro = health.distro;
  writeJson(settingsFile, { ...readJson(settingsFile, {}), distro: health.distro });
}

const distroArgs = (distro) => (distro ? ['-d', distro] : []);

async function ensureDaemon(settings, log) {
  try { const h = await api(settings.port, 'GET', '/health'); rememberDistro(settings, h); return h; } catch {}
  // A hidden wsl.exe on the Windows side runs daemon/start.sh and stays as the
  // daemon's parent. It goes through cmd's `start /b` so Windows Terminal (the
  // default terminal) never gets a console to show, and so it outlives this app.
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', 'wsl.exe', ...distroArgs(settings.distro), '--exec', 'bash',
    winToWsl(path.join(ROOT, 'daemon', 'start.sh')), settings.node || 'node', winToWsl(STATE), String(settings.port)], { stdio: 'ignore', windowsHide: true });
  log('info', 'daemon.launch', { pid: child.pid });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const h = await api(settings.port, 'GET', '/health'); rememberDistro(settings, h); return h; } catch {}
  }
  throw new Error('daemon did not start; see logs/daemon-launch.log and logs/daemon.jsonl');
}

// ---- windows ---------------------------------------------------------------

// A template or theme from the extras folder wins over the repo's one of the same name.
function findJson(kind, name) {
  const dir = extrasDir();
  const own = dir && path.join(dir, kind, `${name}.json`);
  return own && fs.existsSync(own) ? own : path.join(ROOT, kind, `${name}.json`);
}

function themeFor(name) {
  return readJson(findJson('themes', name || 'night'), readJson(path.join(ROOT, 'themes', 'night.json'), {}));
}

function readTemplate(name) {
  return readJson(findJson('templates', name), {});
}

// The extras folder's renderer/*.css and *.js, as file URLs for the page to load.
function extrasAssets(settings) {
  const dir = extrasDir(settings);
  let files = [];
  if (dir) try { files = fs.readdirSync(path.join(dir, 'renderer')).sort(); } catch {}
  const urls = (ext) => files.filter((f) => f.endsWith(ext)).map((f) => pathToFileURL(path.join(dir, 'renderer', f)).href);
  return { css: urls('.css'), js: urls('.js') };
}

// What renderer/index.html gets in its `cfg` query for one session.
function rendererConfig(session, settings, gpu) {
  const font = { ...settings.font, ...(session.font || {}) };
  if (settings.fontSizes?.[session.template]) font.size = settings.fontSizes[session.template];
  const tpl = readTemplate(session.template);
  return {
    session: session.id, template: session.template, port: settings.port, token: token(), gpu, theme: themeFor(session.theme), font,
    padding: settings.padding, scrollSpeed: settings.scrollSpeed, scrollEaseMs: settings.scrollEaseMs, cursorGlideMs: settings.cursorGlideMs,
    cursor: { ...DEFAULTS.cursor, ...settings.cursor }, fadeMs: settings.fadeMs, scrollback: settings.scrollback, title: session.title,
    cwd: session.cwd, home: session.home, messageStart: session.messageStart ?? tpl.messageStart, distro: settings.distro || '',
    launch: tpl.launch || null, r7harness: !!tpl.r7harness, questionColor: tpl.questionColor || '#ffc857', extras: extrasAssets(settings),
  };
}

// A picture shown in a window (tool screenshot), saved so the default viewer can open it full size.
function savePicture(dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
  if (!m) return null;
  const dir = path.join(STATE, 'view');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir).sort().slice(0, -20)) fs.rmSync(path.join(dir, f), { force: true });
  const file = path.join(dir, `picture-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
  return file;
}

// ---- clickable paths ----------------------------------------------------------
// A path printed in a terminal (Windows, WSL, ~/ or relative to the session's
// folder) becomes a link when it exists. Returns the Windows path, or null.

function toWindowsPath(p, cwd, home, distro) {
  if (/^[A-Za-z]:\\/.test(p)) return p;
  if (p.startsWith('~/')) p = `${home}${p.slice(1)}`;
  else if (!p.startsWith('/')) p = path.posix.join(cwd || '/', p);
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
}

// The WSL home folder, asked once, for ~/ paths (older daemons don't report it).
let wslHome = null;
function getWslHome(distro) {
  wslHome ??= new Promise((resolve) => {
    execFile('wsl.exe', [...distroArgs(distro), '--exec', 'printenv', 'HOME'], { windowsHide: true }, (err, out) => resolve(err ? '/root' : out.trim()));
  });
  return wslHome;
}

async function checkPath(p, cwd, home, distro) {
  if (!home && String(p).startsWith('~/')) home = await getWslHome(distro);
  const win = toWindowsPath(String(p), cwd, home, distro);
  try { await fs.promises.access(win); return win; } catch { return null; }
}

module.exports = {
  ROOT, VERSION, STATE, DEFAULTS, settingsFile, readJson, writeJson, readSettings, saveFontSize, makeLog,
  token, api, winToWsl, ensureDaemon, themeFor, readTemplate, rendererConfig, savePicture, checkPath,
  wslToWin, extrasDir, extrasAssets, distroArgs,
};
