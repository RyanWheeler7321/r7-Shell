'use strict';
// Shared by the daemon and the CLI (both run in WSL).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;

// State lives in %LOCALAPPDATA%\r7shell so it stays out of the repo.
// A repo under /mnt/c/Users/<user>/... gives the Windows user directly; otherwise
// Windows is asked once.
let stateCache = '';
function stateDir() {
  if (process.env.R7SHELL_STATE) return process.env.R7SHELL_STATE;
  if (stateCache) return stateCache;
  const m = ROOT.match(/^\/mnt\/([a-z])\/Users\/([^/]+)\//i);
  if (m) return (stateCache = `/mnt/${m[1]}/Users/${m[2]}/AppData/Local/r7shell`);
  try {
    const win = execFileSync('cmd.exe', ['/d', '/c', 'echo', '%LOCALAPPDATA%'], { cwd: '/mnt/c', stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const local = execFileSync('wslpath', ['-u', win]).toString().trim();
    if (!win.includes('%') && local) return (stateCache = path.join(local, 'r7shell'));
  } catch {}
  throw new Error("can't find %LOCALAPPDATA% from Windows; set R7SHELL_STATE");
}

// C:\dir or /mnt/c/dir to /mnt/c/dir.
function winToWsl(p) {
  return String(p).replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

// The `extras` folder from settings.json (your own templates, themes and app
// additions), or ''.
function extrasDir(state = stateDir()) {
  const dir = readJson(path.join(state, 'settings.json'), {}).extras;
  return dir ? winToWsl(dir) : '';
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// JSONL log with simple size rotation: file, file.1, file.2, file.3.
function makeLog(file, maxBytes = 5 * 1024 * 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  return function log(lvl, ev, data) {
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, ev, ...data }) + '\n';
    if (size + line.length > maxBytes) {
      for (let i = 2; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
      try { fs.renameSync(file, `${file}.1`); } catch {}
      size = 0;
    }
    fs.appendFileSync(file, line);
    size += line.length;
  };
}

// Templates come from templates/ and then <extras>/templates, which wins on the
// same name. They reload whenever a file is added, removed or edited, so a change
// applies to the next session; otherwise the cached copy is used.
let templateCache = { key: '', value: {} };
function loadTemplates(state = stateDir()) {
  const extras = extrasDir(state);
  const dirs = [path.join(ROOT, 'templates'), ...(extras ? [path.join(extras, 'templates')] : [])];
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
    for (const f of names) {
      const file = path.join(dir, f);
      try { files.push({ file, name: path.basename(f, '.json'), mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  const key = files.map((f) => `${f.file}:${f.mtime}`).join('|');
  if (key === templateCache.key) return templateCache.value;
  const out = {};
  for (const f of files) {
    const t = readJson(f.file, null);
    if (t) out[f.name] = t;
  }
  templateCache = { key, value: out };
  return out;
}

module.exports = { ROOT, VERSION, stateDir, winToWsl, extrasDir, readJson, writeJson, makeLog, loadTemplates };
