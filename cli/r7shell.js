'use strict';
// r7shell: command line for the r7Shell daemon and app. Runs in WSL.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { ROOT, VERSION, stateDir, readJson, loadTemplates } = require('../daemon/common');

const STATE = stateDir();
const saved = readJson(path.join(STATE, 'settings.json'), {});
const settings = { port: 47890, node: process.execPath, ...saved, distro: saved.distro || process.env.WSL_DISTRO_NAME || '' };
const token = () => { try { return fs.readFileSync(path.join(STATE, 'token'), 'utf8').trim(); } catch { return ''; } };
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

const HELP = `r7shell ${VERSION}: sessions live in the daemon; windows are views of them.

  ls                              sessions (id, template, alive, clients, title)
  templates                       session templates (${path.join(ROOT, 'templates')}, then extras/templates)
  new <template> [--cwd D] [--title T] [--no-open] [--activate]
  open <id> [--activate]          open a window for a session
  close <id>                      close its window, keep the session
  reopen                          bring back the last closed window (within 10 seconds)
  send <id> <text> [--enter]      type into a session (\\n \\r \\t \\e escapes work)
  text <id> [--lines N]           screen text (default: visible screen)
  wait <id> [regex] [--idle MS] [--timeout S]
                                  wait for text (screen or new output), then/or quiet
  kill <id> | restart <id>
  done [id]                       the program's turn finished: the window flashes until
                                  focused (id defaults to $R7SHELL_SESSION)
  pin <file>... [--session id]    pin 1-8 images or videos in the window, newest first
  pin --clear [--session id]      remove the window's pins
  trace <id> on|off               raw output to logs/trace-<id>.log (debugging)
  shot <id> [--out PATH]          PNG of the window, without focusing it
  key <id> <Ctrl+V>               press a key inside the window (tests its shortcuts)
  click <id> <x> <y>              left-click inside the window (tests links)
  drag <id> <x1> <y1> <x2> <y2>   left-drag inside the window (tests selection)
  hover <id> <x> <y>              move the pointer inside the window (tests links)
  js <id> <code>                  run JavaScript in the window's page (tests)
  attention-test <id> <json>      show a made-up turn state: {"phase":"waiting","completedMs":"now"}
  drag-resize <id> <width> <ms> [--shots MS,..]  resize step by step, like dragging an edge
  wheel <id> <notches> [--gap MS] [--shots MS,..]  scroll inside the window (+ down, - up); test shots
  attach <id>                     raw attach here (Ctrl+] detaches)
  windows | displays | stats      app windows, monitors, per-process CPU and memory
  place <id> <display#> | <x> <y> <w> <h>   move a window (no focus change)
  app start [--activate]|quit|restart|reload   app lifecycle; sessions survive all of these
  gpu on|off                      GPU rendering, or zero-GPU mode (restarts the app)
  cursor [auto|block|bar|underline|outline] [--width PX] [--blink MS|off]
                                  cursor look for every window, live; no args shows it
  daemon start|stop|status        the session host (stop ends every session)
  log [daemon|app] [--lines N]
  health

Other commands go to the app, for commands added by the extras folder.`;

// ---- helpers ---------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const has = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const die = (msg) => { console.error(`r7shell: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method, route, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: settings.port, path: route, method, timeout,
      headers: { 'x-r7shell-token': token(), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch {}
        res.statusCode < 300 ? resolve(json) : reject(new Error(json.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error('daemon is not running (r7shell daemon start)') : e));
    req.on('timeout', () => req.destroy(new Error('daemon timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const appCmd = (cmd, args, timeoutMs) => api('POST', '/app', { cmd, args, timeoutMs }, (timeoutMs || 10000) + 2000);
const winPath = (p) => execFileSync('wslpath', ['-w', p]).toString().trim();
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const distroArgs = () => (settings.distro ? ['-d', settings.distro] : []);

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v|mkv|ogv)$/i;

// A file as the pin strip wants it: { kind, name, path } with a Windows path.
function pinMedia(file) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) die(`no file "${file}"`);
  const kind = IMAGE.test(full) ? 'image' : VIDEO.test(full) ? 'video' : die(`"${file}" is not an image or video`);
  return { kind, name: path.basename(full), path: winPath(full) };
}

function startProcess(file, args, hidden) {
  const list = args.map((a) => psQuote(a.includes(' ') ? `"${a}"` : a)).join(',');
  const cmd = `Start-Process -FilePath ${psQuote(file)} -ArgumentList ${list}${hidden ? ' -WindowStyle Hidden' : ''}`;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  if (r.status !== 0) die(`launch failed: ${r.stderr || r.stdout}`);
}

async function health() { try { return await api('GET', '/health', null, 2000); } catch { return null; } }

async function startDaemon() {
  if (await health()) return;
  // Same route as the app: cmd's `start /b` runs a hidden wsl.exe on the Windows
  // side that stays as the daemon's parent, with no console window.
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', 'wsl.exe', ...distroArgs(), '--exec', 'bash',
    path.join(ROOT, 'daemon', 'start.sh'), settings.node, STATE, String(settings.port)], { stdio: 'ignore', detached: true, cwd: '/mnt/c' });
  child.unref();
  for (let i = 0; i < 60; i++) { await sleep(250); if (await health()) return; }
  die(`daemon did not start; see ${path.join(STATE, 'logs', 'daemon.jsonl')}`);
}

async function startApp(extra = []) {
  const exe = path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
  startProcess(winPath(exe), [winPath(path.join(ROOT, 'app')), ...extra], false);
  for (let i = 0; i < 80; i++) { await sleep(250); const h = await health(); if (h && h.app) return; }
  die(`app did not connect; see ${path.join(STATE, 'logs', 'app.jsonl')}`);
}

function unescape(s) {
  return s.replace(/\\(n|r|t|e|\\)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', e: '\x1b', '\\': '\\' }[c]));
}

// ---- commands ----------------------------------------------------------------

async function main() {
  const cmd = argv.shift();
  const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': return out(HELP);
    case 'health': return out((await health()) || { ok: false, error: 'daemon is not running' });
    case 'ls': {
      const list = await api('GET', '/sessions');
      if (!list.length) return out('no sessions');
      for (const s of list) out(`${s.id.padEnd(14)} ${(s.state === 'exited' ? `exited ${s.exitCode}` : s.state).padEnd(9)}  ${String(s.clients).padStart(2)} win  ${s.title}`);
      return;
    }
    case 'templates': return out(await api('GET', '/templates'));
    case 'new': {
      const template = argv.shift() || die('new <template>');
      await startDaemon();
      const noOpen = has('--no-open');
      const activate = has('--activate');
      // A template marked `startsSlow` starts at once instead of waiting for its window:
      // its program reads the terminal size a second later, well after the window attaches.
      const slow = loadTemplates(STATE)[template]?.startsSlow;
      const s = await api('POST', '/sessions', { template, cwd: opt('--cwd'), title: opt('--title'), open: false, deferSpawn: !noOpen && !slow });
      if (!noOpen) {
        const h = await health();
        if (!h.app) await startApp(activate ? [] : ['--inactive']);
        else await appCmd('open', { session: s.id, activate });
      }
      return out(s.id);
    }
    case 'open': {
      const id = argv.shift() || die('open <id>');
      const activate = has('--activate');
      const h = await health();
      if (!h) die('daemon is not running');
      if (!h.app) return startApp(activate ? [] : ['--inactive']);
      return out(await appCmd('open', { session: id, activate }));
    }
    case 'close': return out(await appCmd('close', { session: argv.shift() || die('close <id>') }));
    case 'send': {
      const enter = has('--enter');
      const id = argv.shift() || die('send <id> <text>');
      const text = unescape(argv.join(' ')) + (enter ? '\r' : '');
      return api('POST', `/sessions/${id}/input`, { data: text });
    }
    case 'text': {
      const lines = opt('--lines', '0');
      const id = argv.shift() || die('text <id>');
      return out((await api('GET', `/sessions/${id}/text?lines=${lines}`)).text);
    }
    case 'wait': {
      const timeout = Number(opt('--timeout', '30'));
      const idle = opt('--idle', '');
      const [id, pattern] = argv;
      if (!id || (!pattern && !idle)) die('wait <id> [regex] [--idle MS]');
      const q = new URLSearchParams({ timeout: String(timeout), ...(pattern ? { match: pattern } : {}), ...(idle ? { idle } : {}) });
      return out(await api('GET', `/sessions/${id}/wait?${q}`, null, timeout * 1000 + 5000));
    }
    case 'kill': return out(await api('DELETE', `/sessions/${argv.shift() || die('kill <id>')}`));
    case 'done': {
      // Also a Claude Code Stop hook or Codex `notify` program. Codex adds a JSON
      // argument, and outside a session there is nothing to flash, so both are quiet.
      let id = argv.shift();
      if (id && id.startsWith('{')) id = undefined;
      if (id) return out(await appCmd('done', { session: id }));
      if (!process.env.R7SHELL_SESSION) return;
      await appCmd('done', { session: process.env.R7SHELL_SESSION }).catch(() => {});
      return;
    }
    case 'pin': {
      const session = opt('--session') || process.env.R7SHELL_SESSION || die('pin: no session (--session id)');
      if (has('--clear')) return out(await appCmd('pin', { session, clear: true }));
      if (!argv.length || argv.length > 8) die('pin <file>... (1-8 images or videos) [--session id] | pin --clear');
      return out(await appCmd('pin', { session, media: argv.map(pinMedia) }));
    }
    case 'attention-test': {
      const id = argv.shift() || die('attention-test <id> <json>');
      return out(await appCmd('attention-test', { session: id, data: JSON.parse(argv.shift() || '{}') }));
    }
    case 'trace': {
      const id = argv.shift() || die('trace <id> on|off');
      return out(await api('POST', `/sessions/${id}/trace`, { on: argv.shift() !== 'off' }));
    }
    case 'restart': return out(await api('POST', `/sessions/${argv.shift() || die('restart <id>')}/restart`));
    case 'shot': {
      const file = opt('--out');
      const id = argv.shift() || die('shot <id>');
      const r = await appCmd('shot', { session: id, out: file ? winPath(path.resolve(file)) : undefined });
      return out(r.wsl);
    }
    case 'key': {
      const id = argv.shift() || die('key <id> <Ctrl+Shift+F>');
      const parts = (argv.shift() || die('key <id> <Ctrl+Shift+F>')).split('+');
      const keyCode = parts.pop();
      return out(await appCmd('key', { session: id, keyCode, modifiers: parts.map((m) => ({ ctrl: 'control' }[m.toLowerCase()] || m.toLowerCase())) }));
    }
    case 'js': {
      const id = argv.shift() || die('js <id> <code>');
      return out(await appCmd('js', { session: id, code: argv.join(' ') }));
    }
    case 'click': {
      const id = argv.shift() || die('click <id> <x> <y>');
      return out(await appCmd('click', { session: id, x: Number(argv.shift()), y: Number(argv.shift()) }));
    }
    case 'drag': {
      const id = argv.shift() || die('drag <id> <x1> <y1> <x2> <y2>');
      const [x1, y1, x2, y2] = argv.splice(0, 4).map(Number);
      return out(await appCmd('drag', { session: id, x1, y1, x2, y2 }));
    }
    case 'hover': {
      const id = argv.shift() || die('hover <id> <x> <y>');
      return out(await appCmd('hover', { session: id, x: Number(argv.shift()), y: Number(argv.shift()) }));
    }
    case 'drag-resize': {
      const shots = opt('--shots');
      const id = argv.shift() || die('drag-resize <id> <width> <ms> [--shots MS,MS]');
      return out(await appCmd('drag-resize', { session: id, width: Number(argv.shift()), ms: Number(argv.shift() || 1000), shots: shots ? shots.split(',').map(Number) : [] }));
    }
    case 'wheel': {
      const shots = opt('--shots');
      const gap = opt('--gap');
      const id = argv.shift() || die('wheel <id> <notches> [--gap MS] [--shots MS,MS]');
      return out(await appCmd('wheel', { session: id, notches: Number(argv.shift() || 1), gapMs: Number(gap || 0), shots: shots ? shots.split(',').map(Number) : [] }));
    }
    case 'windows': return out(await appCmd('windows'));
    case 'displays': return out(await appCmd('displays'));
    case 'place': {
      const id = argv.shift() || die('place <id> <display#> | <x> <y> <w> <h>');
      const n = argv.map(Number);
      if (n.length === 1) return out(await appCmd('place', { session: id, display: n[0] }));
      if (n.length === 4) return out(await appCmd('place', { session: id, bounds: { x: n[0], y: n[1], width: n[2], height: n[3] } }));
      return die('place <id> <display#> | <x> <y> <w> <h>');
    }
    case 'stats': return out({ daemon: await health(), app: await appCmd('stats').catch((e) => ({ error: e.message })) });
    case 'attach': return attach(argv.shift() || die('attach <id>'));
    case 'app': {
      const sub = argv.shift();
      if (sub === 'start') { const activate = has('--activate'); await startDaemon(); const h = await health(); return h.app ? out('already running') : startApp(activate ? [] : ['--inactive']); }
      if (sub === 'quit') return out(await appCmd('quit'));
      if (sub === 'reload') return out(await appCmd('reload', { session: argv.shift() }));
      if (sub === 'restart') {
        await appCmd('quit').catch(() => {});
        for (let i = 0; i < 40; i++) { await sleep(250); const h = await health(); if (!h.app) break; }
        return startApp(['--inactive']);
      }
      return die('app start|quit|restart|reload');
    }
    case 'gpu': {
      const mode = argv.shift();
      if (mode !== 'on' && mode !== 'off') die('gpu on|off');
      const file = path.join(STATE, 'settings.json');
      const current = readJson(file, {});
      fs.writeFileSync(file, JSON.stringify({ ...current, gpu: mode === 'on' }, null, 2));
      const h = await health();
      if (h && h.app) { await appCmd('quit').catch(() => {}); for (let i = 0; i < 40; i++) { await sleep(250); if (!(await health()).app) break; } await startApp(['--inactive']); }
      return out(`gpu ${mode}`);
    }
    case 'cursor': {
      const look = {};
      const width = opt('--width');
      const blink = opt('--blink');
      if (width) look.width = Number(width);
      if (blink) look.blinkMs = blink === 'off' ? 0 : Number(blink);
      const shape = argv.shift();
      if (shape && !['auto', 'block', 'bar', 'underline', 'outline'].includes(shape)) die('cursor [auto|block|bar|underline|outline] [--width PX] [--blink MS|off]');
      if (shape) look.shape = shape;
      return out(await appCmd('cursor', { look }));
    }
    case 'daemon': {
      const sub = argv.shift();
      if (sub === 'start') { await startDaemon(); return out(await health()); }
      if (sub === 'status') return out((await health()) || 'not running');
      if (sub === 'stop') {
        const h = await health();
        if (!h) return out('not running');
        process.kill(h.pid, 'SIGTERM');
        return out(`stopped pid ${h.pid}`);
      }
      return die('daemon start|stop|status');
    }
    case 'log': {
      const lines = Number(opt('--lines', '40'));
      const which = argv.shift() || 'daemon';
      const file = path.join(STATE, 'logs', `${which}.jsonl`);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd().split('\n') : [];
      return out(text.slice(-lines).join('\n'));
    }
    default: {
      // Commands the extras folder adds to the app get the rest of the line as `argv`.
      try {
        return out(await appCmd(cmd, { argv }));
      } catch (e) {
        if (/^unknown command/.test(e.message)) die(`unknown command "${cmd}"\n\n${HELP}`);
        throw e;
      }
    }
  }
}

function attach(id) {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 34;
  const ws = new WebSocket(`ws://127.0.0.1:${settings.port}/ws?session=${encodeURIComponent(id)}&token=${token()}&cols=${cols}&rows=${rows}`);
  ws.binaryType = 'arraybuffer';
  const done = (msg) => { if (process.stdin.isTTY) process.stdin.setRawMode(false); if (msg) process.stderr.write(`\r\n${msg}\r\n`); process.exit(0); };
  ws.onopen = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', (d) => { if (d.length === 1 && d[0] === 0x1d) return done('[detached]'); ws.send(d); });
    process.stdout.on('resize', () => ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows })));
  };
  let snapshotNext = false;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      if (snapshotNext) { snapshotNext = false; process.stdout.write('\x1bc'); }
      process.stdout.write(Buffer.from(ev.data));
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') snapshotNext = true;
    if (msg.type === 'exit') process.stderr.write(`\r\n[process exited ${msg.code}]\r\n`);
  };
  ws.onclose = (ev) => done(`[connection closed: ${ev.reason || ev.code}]`);
}

main().catch((e) => die(e.message));
