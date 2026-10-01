'use strict';
// r7Shell session daemon. Runs in WSL, owns every terminal session, and keeps a
// headless copy of each screen so windows can close, reload or crash and reattach
// to the exact same state. The app and the CLI are both just clients of this.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { WebSocketServer } = require('ws');
const { ROOT, stateDir, readJson, writeJson, makeLog, loadTemplates, VERSION } = require('./common');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const STATE = argValue('--state', '') || stateDir();
fs.mkdirSync(STATE, { recursive: true });
const settings = readJson(path.join(STATE, 'settings.json'), {});
const PORT = Number(argValue('--port', settings.port || 47890));
const SCROLLBACK = settings.scrollback || 10000;
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;
// Terminal replies (device attributes, cursor reports, mode reports, color and DCS/APC answers).
const QUERY_REPLY = /^\x1b(\[\??[\d;]*[cRnt]|\[\??[\d;]*\$y|\[\?\d*u|\][\d;]+;[^\x07\x1b]*(\x07|\x1b\\)|P[\s\S]*\x1b\\|_[\s\S]*\x1b\\)$/;
const SESSIONS_FILE = path.join(STATE, 'sessions.json');
const log = makeLog(path.join(STATE, 'logs', 'daemon.jsonl'));

const tokenFile = path.join(STATE, 'token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenFile, TOKEN);
}

const sessions = new Map();
let appClient = null;
const appWaiters = new Map();
const started = Date.now();

function saveSessions() {
  const list = [...sessions.values()].map((s) => ({
    id: s.id, template: s.template, title: s.title, cwd: s.cwd, cols: s.cols, rows: s.rows, created: s.created,
  }));
  writeJson(SESSIONS_FILE, list);
}

function nextId(template) {
  for (let n = 1; ; n++) {
    const id = `${template}-${n}`;
    if (!sessions.has(id)) return id;
  }
}

function spawnPty(s) {
  const tpl = loadTemplates(STATE)[s.template];
  if (!tpl) throw new Error(`no template "${s.template}"`);
  const command = tpl.command || '';
  let shellArgs = ['-li'];
  if (command) shellArgs = ['-lic', tpl.keepShell === false ? command : `${command}; exec bash -li`];
  const env = { ...process.env, ...(tpl.env || {}) };
  for (const k of ['WT_SESSION', 'WT_PROFILE_ID', 'TMUX', 'TMUX_PANE']) delete env[k];
  Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'r7shell', TERM_PROGRAM_VERSION: VERSION, R7SHELL_SESSION: s.id, R7SHELL_ROOT: ROOT });
  const cwd = fs.existsSync(s.cwd) ? s.cwd : process.env.HOME;
  const p = pty.spawn('/bin/bash', shellArgs, { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd, env, encoding: null });
  s.pty = p;
  s.alive = true;
  s.exitCode = null;
  s.pid = p.pid;
  s.inflight = 0;
  s.paused = false;
  // A restarted session gets a new pty; the old one's late events must not touch it.
  p.onData((data) => { if (s.pty === p) onOutput(s, data); });
  p.onExit(({ exitCode, signal }) => {
    if (s.pty !== p) return;
    s.alive = false;
    s.exitCode = exitCode;
    log('info', 'session.exit', { id: s.id, exitCode, signal });
    broadcast(s, { type: 'exit', code: exitCode });
  });
  log('info', 'session.spawn', { id: s.id, template: s.template, pid: s.pid, cwd, cols: s.cols, rows: s.rows });
}

function startPty(s) {
  clearTimeout(s.spawnTimer);
  s.spawnTimer = null;
  if (!s.pty && sessions.has(s.id)) spawnPty(s);
}

// Colors a program sets (OSC 4/10/11/12/17) aren't part of the serialized screen,
// so they are kept here and replayed ahead of every snapshot. Otherwise a reopened
// window shows the wrong look. The same goes for a program's OSC 7321 `hello`,
// which turns on r7Harness features in the window.
function trackColors(s) {
  s.colors = new Map();
  s.hello = null;
  for (const code of [10, 11, 12, 17]) {
    s.term.parser.registerOscHandler(code, (d) => { if (d !== '?') s.colors.set(String(code), d); return false; });
    s.term.parser.registerOscHandler(code + 100, () => { s.colors.delete(String(code)); return false; });
  }
  s.term.parser.registerOscHandler(4, (d) => {
    const p = d.split(';');
    for (let i = 0; i + 1 < p.length; i += 2) if (p[i + 1] !== '?') s.colors.set(`4;${p[i]}`, p[i + 1]);
    return false;
  });
  s.term.parser.registerOscHandler(104, () => {
    for (const k of [...s.colors.keys()]) if (k.startsWith('4;')) s.colors.delete(k);
    return false;
  });
  s.term.parser.registerOscHandler(7321, (d) => {
    if (d === 'hello' || d.startsWith('hello;')) s.hello = d;
    return false;
  });
}

function replayPrefix(s) {
  let out = '';
  for (const [k, v] of s.colors) out += `\x1b]${k};${v}\x07`;
  if (s.hello) out += `\x1b]7321;${s.hello}\x07`;
  return out;
}

function createSession({ template, cwd, title, cols, rows, id, deferSpawn }) {
  const templates = loadTemplates(STATE);
  const tpl = templates[template];
  if (!tpl) throw new Error(`no template "${template}" (have: ${Object.keys(templates).join(', ')})`);
  const s = {
    id: id || nextId(template), template, title: title || tpl.title || template,
    cwd: cwd || tpl.cwd || process.env.HOME, cols: cols || 120, rows: rows || 34,
    created: new Date().toISOString(), clients: new Set(), bytesOut: 0, lastOutput: null, batch: [], waiters: new Set(),
  };
  s.term = new Terminal({ cols: s.cols, rows: s.rows, scrollback: SCROLLBACK, allowProposedApi: true });
  s.serializer = new SerializeAddon();
  s.term.loadAddon(s.serializer);
  trackColors(s);
  // Programs ask the terminal questions (colors, cursor position, features).
  // A window answers while one is attached; otherwise the headless copy does.
  const answer = (d) => { if (s.alive && !s.primary) s.pty.write(d); };
  s.term.onData(answer);
  s.term.onBinary(answer);
  s.term.onTitleChange((t) => {
    if (!t || tpl.fixedTitle) return;
    s.title = t;
    broadcast(s, { type: 'title', title: t });
  });
  sessions.set(s.id, s);
  // A session about to get a window waits for it (up to 3s), so the program
  // starts at the window's real size and the window answers its first questions.
  if (deferSpawn) s.spawnTimer = setTimeout(() => startPty(s), 3000);
  else spawnPty(s);
  saveSessions();
  return s;
}

// Output is batched for a few ms so fast programs make fewer, larger frames,
// and the pty is paused while the headless copy is behind, so memory stays bounded.
function onOutput(s, data) {
  if (s.trace) fs.appendFileSync(s.trace, data);
  s.bytesOut += data.length;
  s.lastOutput = Date.now();
  s.batch.push(data);
  if (!s.batchTimer) s.batchTimer = setTimeout(() => flushOutput(s), 4);
  for (const w of s.waiters) w.onOutput(data);
}

function flushOutput(s) {
  s.batchTimer = null;
  if (!s.batch.length) return;
  const buf = s.batch.length === 1 ? s.batch[0] : Buffer.concat(s.batch);
  s.batch = [];
  s.inflight += buf.length;
  if (!s.paused && s.inflight > 2 * 1024 * 1024 && s.pty) { s.paused = true; s.pty.pause(); }
  s.term.write(buf, () => {
    s.inflight -= buf.length;
    if (s.paused && s.inflight < 512 * 1024 && s.pty) { s.paused = false; s.pty.resume(); }
  });
  for (const c of s.clients) {
    if (c.pending) { c.pending.push(buf); continue; }
    if (c.ws.bufferedAmount > SLOW_CLIENT_BYTES) {
      log('warn', 'client.slow', { id: s.id, buffered: c.ws.bufferedAmount });
      c.ws.close(4000, 'slow client, reattach');
      continue;
    }
    c.ws.send(buf);
  }
}

function broadcast(s, msg) {
  const text = JSON.stringify(msg);
  for (const c of s.clients) if (!c.pending) c.ws.send(text);
}

function resizeSession(s, cols, rows) {
  cols = Math.max(2, Math.min(1000, cols | 0));
  rows = Math.max(1, Math.min(500, rows | 0));
  if (cols === s.cols && rows === s.rows) return;
  s.cols = cols;
  s.rows = rows;
  s.term.resize(cols, rows);
  if (s.alive && s.pty) s.pty.resize(cols, rows);
}

function killSession(s) {
  clearTimeout(s.spawnTimer);
  clearTimeout(s.batchTimer);
  for (const w of s.waiters) w.finish(410, { error: 'session closed' });
  if (s.alive) { try { s.pty.kill(); } catch {} }
  for (const c of s.clients) c.ws.close(4001, 'session closed');
  s.term.dispose();
  sessions.delete(s.id);
  saveSessions();
  log('info', 'session.kill', { id: s.id });
}

function restartSession(s) {
  const old = s.pty;
  s.pty = null;
  s.alive = false;
  s.primary = null;
  if (old) { try { old.kill(); } catch {} }
  s.batch = [];
  s.term.reset();
  s.colors.clear();
  s.hello = null;
  const hadWindows = s.clients.size > 0;
  for (const c of s.clients) c.ws.close(4002, 'restarted, reattach');
  s.clients.clear();
  log('info', 'session.restart', { id: s.id });
  if (hadWindows) s.spawnTimer = setTimeout(() => startPty(s), 3000);
  else spawnPty(s);
}

function screenText(s, lines) {
  const b = s.term.buffer.active;
  let end = b.length;
  while (end > 0 && !b.getLine(end - 1)?.translateToString(true)) end--;
  const start = lines ? Math.max(0, end - lines) : Math.min(b.baseY, end);
  const out = [];
  for (let i = start; i < end; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n');
}

function info(s) {
  const tpl = loadTemplates(STATE)[s.template];
  const b = s.term.buffer.active;
  return {
    id: s.id, template: s.template, title: s.title, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.pid,
    cursor: { x: b.cursorX, y: b.cursorY }, altScreen: b.type === 'alternate',
    state: s.pty ? (s.alive ? 'running' : 'exited') : 'starting', alive: !!s.alive, exitCode: s.exitCode, created: s.created, clients: s.clients.size, bytesOut: s.bytesOut,
    lastOutput: s.lastOutput ? new Date(s.lastOutput).toISOString() : null,
    theme: tpl?.theme || null, font: tpl?.font || null, messageStart: tpl?.messageStart || null, home: process.env.HOME,
  };
}

// ---- wait: match text (on screen or in output since the call) and/or quiet --

const ANSI = /\x1b(\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|.)/g;

function waitFor(s, q, res) {
  const re = q.get('match') ? new RegExp(q.get('match'), 'm') : null;
  const idleMs = Number(q.get('idle')) || 0;
  const timeoutMs = (Number(q.get('timeout')) || 30) * 1000;
  if (!re && !idleMs) return send(res, 400, { error: 'wait needs match and/or idle' });
  let seen = '';
  let matched = !re || re.test(screenText(s, 200));
  let idleTimer = null;
  const w = {
    finish(code, body) {
      clearTimeout(w.timer); clearTimeout(idleTimer); s.waiters.delete(w);
      send(res, code, body);
    },
    check() {
      if (matched && !idleMs) return w.finish(200, { matched: true });
      if (matched && idleMs) { clearTimeout(idleTimer); idleTimer = setTimeout(() => w.finish(200, { matched: !!re, idle: true }), idleMs); }
    },
    onOutput(data) {
      if (re && !matched) {
        seen = (seen + data.toString('utf8').replace(ANSI, '')).slice(-65536);
        matched = re.test(seen) || re.test(screenText(s, 200));
      }
      if (matched) w.check();
    },
  };
  w.timer = setTimeout(() => w.finish(408, { error: `timed out after ${timeoutMs / 1000}s`, matched }), timeoutMs);
  s.waiters.add(w);
  res.on('close', () => { if (s.waiters.has(w)) { clearTimeout(w.timer); clearTimeout(idleTimer); s.waiters.delete(w); } });
  w.check();
}

// ---- app control channel -------------------------------------------------

function askApp(cmd, argsObj, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!appClient) return reject(new Error('r7Shell app is not running'));
    const id = crypto.randomBytes(6).toString('hex');
    const timer = setTimeout(() => { appWaiters.delete(id); reject(new Error(`app did not answer "${cmd}"`)); }, timeoutMs);
    appWaiters.set(id, { resolve, reject, timer });
    appClient.send(JSON.stringify({ id, cmd, args: argsObj || {} }));
  });
}

// ---- HTTP API --------------------------------------------------------------

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.headers['x-r7shell-token'] !== TOKEN && url.searchParams.get('token') !== TOKEN) return send(res, 403, { error: 'bad token' });
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method;

  if (m === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, version: VERSION, pid: process.pid, distro: process.env.WSL_DISTRO_NAME || '', uptimeS: Math.round((Date.now() - started) / 1000), sessions: sessions.size, app: !!appClient, rssMB: Math.round(process.memoryUsage().rss / 1048576) });
  }
  if (m === 'GET' && url.pathname === '/templates') return send(res, 200, loadTemplates(STATE));
  if (m === 'GET' && url.pathname === '/sessions') return send(res, 200, [...sessions.values()].map(info));
  if (m === 'POST' && url.pathname === '/sessions') {
    const body = await readBody(req);
    let s;
    try { s = createSession(body); } catch (e) { return send(res, 400, { error: e.message }); }
    let window = null;
    if (body.open !== false && appClient) {
      try { window = await askApp('open', { session: s.id, activate: !!body.activate }); } catch (e) { window = { error: e.message }; }
    }
    return send(res, 200, { ...info(s), window });
  }
  if (url.pathname === '/app' && m === 'POST') {
    const body = await readBody(req);
    try { return send(res, 200, await askApp(body.cmd, body.args, body.timeoutMs)); } catch (e) { return send(res, 503, { error: e.message }); }
  }
  if (m === 'GET' && url.pathname === '/log') {
    return send(res, 200, { path: path.join(STATE, 'logs', 'daemon.jsonl') });
  }
  if (parts[0] === 'sessions' && parts[1]) {
    const s = sessions.get(parts[1]);
    if (!s) return send(res, 404, { error: `no session "${parts[1]}"` });
    const action = parts[2];
    if (m === 'GET' && !action) return send(res, 200, info(s));
    if (m === 'GET' && action === 'wait') return waitFor(s, url.searchParams, res);
    if (m === 'GET' && action === 'text') return send(res, 200, { text: screenText(s, Number(url.searchParams.get('lines')) || 0) });
    if (m === 'DELETE' && !action) { killSession(s); return send(res, 200, { ok: true }); }
    if (m === 'POST') {
      const body = await readBody(req);
      if (action === 'input') {
        if (!s.alive) return send(res, 409, { error: 'session has exited' });
        s.pty.write(String(body.data ?? ''));
        return send(res, 200, { ok: true });
      }
      if (action === 'resize') { resizeSession(s, body.cols, body.rows); return send(res, 200, info(s)); }
      if (action === 'restart') { restartSession(s); return send(res, 200, info(s)); }
      if (action === 'trace') {
        s.trace = body.on ? path.join(STATE, 'logs', `trace-${s.id}.log`) : null;
        log('info', 'session.trace', { id: s.id, file: s.trace });
        return send(res, 200, { trace: s.trace });
      }
    }
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => { log('error', 'http.error', { path: req.url.split('?')[0], error: e.message }); send(res, 500, { error: e.message }); });
});

// ---- WebSocket: terminal clients and the app control channel ---------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') !== TOKEN) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/ws/app') return attachApp(ws);
    if (url.pathname === '/ws') return attachClient(ws, url.searchParams);
    ws.close(4004, 'unknown path');
  });
});

function attachApp(ws) {
  if (appClient) appClient.close(4003, 'replaced by a newer app');
  appClient = ws;
  log('info', 'app.connect', {});
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const w = appWaiters.get(msg.id);
    if (!w) return;
    clearTimeout(w.timer);
    appWaiters.delete(msg.id);
    msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error || 'app error'));
  });
  ws.on('close', () => {
    if (appClient !== ws) return;
    appClient = null;
    for (const [id, w] of appWaiters) { clearTimeout(w.timer); w.reject(new Error('r7Shell app disconnected')); appWaiters.delete(id); }
    log('info', 'app.disconnect', {});
  });
}

function attachClient(ws, params) {
  const s = sessions.get(params.get('session'));
  if (!s) { ws.close(4004, 'no such session'); return; }
  const cols = Number(params.get('cols'));
  const rows = Number(params.get('rows'));
  if (cols && rows) resizeSession(s, cols, rows);
  // Everything written before the marker is in the snapshot; everything after
  // is buffered in `pending` and sent right behind it, so nothing is lost or doubled.
  const client = { ws, pending: [] };
  s.clients.add(client);
  if (!s.primary) s.primary = client;
  flushOutput(s);
  s.term.write('', () => {
    if (ws.readyState !== ws.OPEN) return;
    // Header as JSON, then the snapshot itself as one binary frame.
    const snap = Buffer.from(replayPrefix(s) + s.serializer.serialize({ scrollback: SCROLLBACK }), 'utf8');
    ws.send(JSON.stringify({ type: 'snapshot', bytes: snap.length, cols: s.cols, rows: s.rows, title: s.title, alive: s.alive, exitCode: s.exitCode }));
    ws.send(snap);
    for (const buf of client.pending) ws.send(buf);
    client.pending = null;
    if (!s.pty) startPty(s);
  });
  log('info', 'client.attach', { id: s.id, clients: s.clients.size });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const text = raw.toString('utf8');
      // Only one window answers terminal queries, or the program gets doubles.
      if (client !== s.primary && QUERY_REPLY.test(text)) return;
      if (s.alive) s.pty.write(text);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'resize') resizeSession(s, msg.cols, msg.rows);
    else if (msg.type === 'restart') restartSession(s);
    else if (msg.type === 'input' && s.alive) s.pty.write(String(msg.data));
  });
  ws.on('close', () => {
    s.clients.delete(client);
    if (s.primary === client) s.primary = [...s.clients][0] || null;
  });
}

// ---- start -----------------------------------------------------------------

server.on('error', (e) => {
  // Two launches racing (app and CLI at once) is harmless: the first one serves.
  if (e.code === 'EADDRINUSE') log('info', 'daemon.already-running', { port: PORT });
  else log('error', 'daemon.listen', { port: PORT, error: e.message });
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});

server.listen(PORT, '127.0.0.1', () => {
  log('info', 'daemon.start', { version: VERSION, pid: process.pid, port: PORT, node: process.version });
  for (const saved of readJson(SESSIONS_FILE, [])) {
    try { createSession(saved); log('info', 'session.relaunch', { id: saved.id }); }
    catch (e) { log('error', 'session.relaunch', { id: saved.id, error: e.message }); }
  }
  saveSessions();
});

function shutdown(signal) {
  log('info', 'daemon.stop', { signal, sessions: sessions.size });
  for (const s of sessions.values()) { try { s.pty.kill(); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { log('error', 'daemon.uncaught', { error: e.stack || e.message }); });
