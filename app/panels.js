'use strict';
// Session panels (`r7shell panel`): what the session's program is making, drawn across the
// top of its window by renderer/panel.js: a main view, up to three smaller views and a
// column of buttons, one of which can be the Play cell.
//
// - Pictures: a legacy `image` file, or a `views` manifest (JSON) the program rewrites last,
//   after its images. Their folders are watched (no polling), so a new file shows at once.
// - `watch`: folders whose changes start the program's own `render` command, hidden: a quick
//   main view a few seconds after edits pause (at most once per minGapMs), and every view
//   when the agent's turn ends (`panelTurnEnd`). Never while the
//   session's game runs. Nothing runs while nothing changes.
// - Buttons run their argv as normal visible Windows programs. A `play` button is the Play
//   cell: a second press closes the program, then kills it after 1s if needed.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

module.exports = function panelsMain({ windows, log, api, STATE, settings, shared, ipcMain }) {
  const { readJson, writeJson } = shared;
  const panels = new Map(); // session id -> saved state (see panelSet)
  const procs = new Map(); // `${session}\n${button}` -> { child, pid, image, at, exited }
  const starting = new Map(); // same key -> start time, while a press builds or spawns
  const failures = new Map(); // same key -> last start failure, shown in the Play cell until the next press
  const watchers = new Map(); // `${session}\n${what}` -> { watcher, timer }
  const triggers = new Map(); // session id -> render trigger state (see onChange)
  const keyOf = (id, button) => `${id}\n${button}`;
  const panelsFile = path.join(STATE, 'panels.json');

  // ---- saved state ---------------------------------------------------------------

  // Panels and the programs their buttons started outlive an app restart (sessions keep running),
  // so both are saved here and taken back on start. Both copies run for a moment during a restart.
  function panelsSave() {
    const saved = {};
    for (const [key, p] of procs) if (!p.exited) saved[key] = { pid: p.pid, image: p.image, at: p.at };
    const states = {};
    for (const [id, s] of panels) states[id] = { ...s, manifest: undefined, versions: undefined };
    const timing = {};
    for (const [id, t] of triggers) timing[id] = { lastRun: t.lastRun, changed: t.changed || !!t.child, finalDirty: t.finalDirty, firstChange: t.firstChange, lastChange: t.lastChange };
    writeJson(panelsFile, { panels: states, procs: saved, timing });
  }

  const windowsPidImage = (pid) => new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      const m = !err && /^"([^"]+)","(\d+)"/m.exec(out || '');
      resolve(m && Number(m[2]) === pid ? m[1].toLowerCase() : '');
    });
  });

  // A program started before the restart: kept while that pid still runs the same program.
  async function panelsAdopt() {
    const saved = readJson(panelsFile, { panels: {}, procs: {} });
    const sessions = new Set((await api('GET', '/sessions').catch(() => [])).map((x) => x.id));
    for (const [id, state] of Object.entries(saved.panels || {})) {
      if (!sessions.has(id) || panels.has(id)) continue;
      panels.set(id, { image: '', version: 0, caption: '', views: '', watch: null, buttons: [], ...state });
      const timing = saved.timing?.[id];
      if (timing && state.watch) triggers.set(id, { timer: 0, child: null, pending: '', watchers: [], waitShow: false, playEnded: false, ...timing });
      watchAll(id);
      if (windows.has(id)) sendPanel(id);
    }
    for (const [key, p] of Object.entries(saved.procs || {})) {
      if (procs.has(key) || !p.image || (await windowsPidImage(p.pid)) !== p.image) continue;
      const proc = { child: null, pid: p.pid, image: p.image, at: p.at, exited: false };
      const [id, button] = key.split('\n');
      // Its session closed while the app was down: it goes the way it would have.
      if (!sessions.has(id)) { await panelKill(id, button, proc); continue; }
      procs.set(key, proc);
    }
    panelsSave();
    log('info', 'panel.adopt', { panels: panels.size, procs: procs.size });
    panelSweep();
  }

  // Every 10s, only while it's needed: a windowless session's panel or program (a window's
  // close ends its panel itself, `panelEnd`), or an adopted program, which has no child
  // handle to report its exit. A panel on a window costs nothing here.
  let sweepTimer = 0;
  function sweepNeeded() {
    for (const id of panels.keys()) if (!windows.has(id)) return true;
    for (const [key, p] of procs) if (!p.exited && (!p.child || !windows.has(key.split('\n')[0]))) return true;
    return false;
  }
  function panelSweep() {
    if (sweepTimer || !sweepNeeded()) return;
    sweepTimer = setTimeout(async () => {
      sweepTimer = 0;
      let sessions = null;
      try { sessions = new Set((await api('GET', '/sessions')).map((x) => x.id)); } catch {}
      const ids = new Set([...panels.keys(), ...[...procs.keys()].map((k) => k.split('\n')[0])]);
      if (sessions) for (const id of ids) if (!sessions.has(id)) panelEnd(id);
      for (const [key, p] of procs) {
        if (p.child || p.exited) continue;
        if ((await windowsPidImage(p.pid)) === p.image) continue;
        procExited(key, p, { adopted: true });
      }
      panelSweep();
    }, 10000);
  }

  // A closed session takes its panel and the programs its buttons started with it.
  function panelEnd(id) {
    const had = panels.has(id);
    if (had) { unwatchAll(id); panels.delete(id); }
    let killed = 0;
    for (const [key, p] of procs) {
      if (!key.startsWith(`${id}\n`)) continue;
      if (!p.exited) { panelKill(id, key.slice(id.length + 1), p); killed++; }
      procs.delete(key);
    }
    if (!had && !killed) return;
    log('info', 'panel.end', { id, killed });
    panelsSave();
  }

  // ---- what the page draws -----------------------------------------------------------

  const mtime = (file) => fs.promises.stat(file).then((s) => Math.round(s.mtimeMs), () => 0);
  const running = (id, button) => { const p = procs.get(keyOf(id, button)); return !!p && !p.exited; };
  const playButton = (s) => s?.buttons.find((b) => b.play);
  const playRunning = (id) => { const b = playButton(panels.get(id)); return !!b && running(id, b.id); };

  function sendPanel(id) {
    const win = windows.get(id);
    if (!win || win.isDestroyed()) return;
    const s = panels.get(id);
    if (!s) return win.webContents.send('panel', null);
    const m = s.manifest;
    const v = s.versions || {};
    let main = null;
    if (m?.main && v[m.main.file]) main = { file: m.main.file, version: v[m.main.file], caption: m.main.caption || s.caption };
    else if (s.image) main = { file: s.image, version: s.version, caption: s.caption };
    const views = (m?.views || []).filter((x) => v[x.file]).map((x) => ({ file: x.file, version: v[x.file], label: x.label || '' }));
    const pb = playButton(s);
    const pk = pb && keyOf(id, pb.id);
    const play = pb ? {
      id: pb.id, running: running(id, pb.id),
      starting: starting.has(pk) ? starting.get(pk) : 0, error: failures.get(pk) || '',
    } : null;
    const others = s.buttons.filter((b) => !b.play);
    win.webContents.send('panel', {
      aspect: m?.aspect || 16 / 9,
      main,
      views,
      play,
      buttons: others.map((b) => ({ id: b.id, label: b.label })),
      running: others.filter((b) => running(id, b.id)).map((b) => b.id),
    });
  }

  // ---- file watching ---------------------------------------------------------------

  function unwatch(id, what) {
    const w = watchers.get(keyOf(id, what));
    if (!w) return;
    clearTimeout(w.timer);
    try { w.watcher.close(); } catch {}
    watchers.delete(keyOf(id, what));
  }

  // A panel update keeps its render timing (`keep`); a cleared or ended panel forgets it.
  function unwatchAll(id, keep) {
    for (const what of ['image', 'views']) unwatch(id, what);
    const t = triggers.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    t.timer = 0;
    for (const w of t.watchers) try { w.close(); } catch {}
    t.watchers = [];
    if (!keep) triggers.delete(id);
  }

  // The folder, not the file: programs often write a new file and rename it over the old.
  function watchFile(id, what, file, onChange) {
    unwatch(id, what);
    if (!file) return;
    const base = path.basename(file).toLowerCase();
    const w = { watcher: null, timer: 0 };
    try {
      w.watcher = fs.watch(path.dirname(file), { persistent: false }, (_ev, name) => {
        if (name && String(name).toLowerCase() !== base) return;
        clearTimeout(w.timer);
        w.timer = setTimeout(onChange, 120);
      });
    } catch (e) { return log('warn', 'panel.watch', { id, file, error: e.message }); }
    w.watcher.on('error', (e) => { log('warn', 'panel.watch', { id, file, error: e.message }); unwatch(id, what); });
    watchers.set(keyOf(id, what), w);
  }

  function watchAll(id) {
    const s = panels.get(id);
    if (!s) return;
    watchFile(id, 'image', s.image, () => refreshImage(id));
    watchFile(id, 'views', s.views, () => refreshViews(id));
    if (s.views) refreshViews(id);
    watchTriggers(id);
  }

  async function refreshImage(id) {
    const s = panels.get(id);
    if (!s?.image) return;
    const version = await mtime(s.image);
    if (version === s.version || panels.get(id) !== s) return;
    s.version = version;
    sendPanel(id);
    log('info', 'panel.image', { id, file: s.image, version });
  }

  // views.json: { aspect?, main: { file, caption? }, views: [{ file, label? }] }; files relative
  // to the manifest's folder or absolute.
  async function refreshViews(id) {
    const s = panels.get(id);
    if (!s?.views) return;
    let m;
    try { m = JSON.parse(await fs.promises.readFile(s.views, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') log('warn', 'panel.views', { id, file: s.views, error: e.message });
      return;
    }
    const dir = path.dirname(s.views);
    const abs = (f) => (f ? panelPath(path.win32.isAbsolute(f) || f.startsWith('/') ? f : path.join(dir, f)) : '');
    const manifest = {
      aspect: Math.min(2.4, Math.max(1, Number(m.aspect) || 16 / 9)),
      main: m.main?.file ? { file: abs(m.main.file), caption: String(m.main.caption || '').slice(0, 200) } : null,
      views: (Array.isArray(m.views) ? m.views : []).slice(0, 3).filter((x) => x?.file).map((x) => ({ file: abs(x.file), label: String(x.label || '').slice(0, 40) })),
    };
    const files = [manifest.main?.file, ...manifest.views.map((x) => x.file)].filter(Boolean);
    const versions = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await mtime(f)])));
    if (panels.get(id) !== s) return;
    s.manifest = manifest;
    s.versions = versions;
    sendPanel(id);
    log('info', 'panel.views', { id, main: !!manifest.main, views: manifest.views.length });
  }

  // ---- render triggers ---------------------------------------------------------------

  // A change under a watched folder marks the session changed. The quick render (main view
  // only) waits until edits pause for quietMs, or minGapMs after the first unrendered change
  // when they never pause, and never comes sooner than minGapMs after the last render.
  function watchTriggers(id) {
    const old = triggers.get(id);
    if (old) { clearTimeout(old.timer); for (const w of old.watchers) try { w.close(); } catch {} }
    const s = panels.get(id);
    if (!s?.watch) { triggers.delete(id); return; }
    const t = old || { timer: 0, lastRun: 0, firstChange: 0, lastChange: 0, changed: false, finalDirty: false, child: null, pending: '', waitShow: false, turnWhilePlaying: false };
    t.watchers = [];
    t.timer = 0;
    // A name skips any path part equal to it; `*.ext` skips files ending in .ext.
    const ignore = new Set(s.watch.ignore.filter((x) => !x.startsWith('*')).map((x) => x.toLowerCase()));
    const ends = s.watch.ignore.filter((x) => x.startsWith('*')).map((x) => x.slice(1).toLowerCase());
    for (const dir of s.watch.dirs) {
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, (_ev, name) => {
          const n = String(name || '').toLowerCase();
          if (n && (n.split(/[\\/]/).some((part) => ignore.has(part)) || ends.some((e) => n.endsWith(e)))) return;
          onChange(id);
        });
        w.on('error', (e) => log('warn', 'panel.trigger_watch', { id, dir, error: e.message }));
        t.watchers.push(w);
      } catch (e) { log('warn', 'panel.trigger_watch', { id, dir, error: e.message }); }
    }
    triggers.set(id, t);
    if (t.changed) plan(id);
  }

  function onChange(id) {
    const t = triggers.get(id);
    if (!t) return;
    const now = Date.now();
    if (!t.changed) t.firstChange = now;
    const first = !t.finalDirty;
    t.changed = true;
    t.finalDirty = true;
    t.lastChange = now;
    if (first) panelsSave(); // once per turn, so a restart keeps it
    plan(id);
  }

  function plan(id) {
    const t = triggers.get(id);
    const s = panels.get(id);
    if (!t || !s?.watch || !t.changed || t.child) return;
    clearTimeout(t.timer);
    const { quietMs, minGapMs } = s.watch;
    const at = Math.max(t.lastRun + minGapMs, Math.min(t.lastChange + quietMs, t.firstChange + minGapMs));
    t.timer = setTimeout(() => {
      t.timer = 0;
      if (playRunning(id)) return; // the game gets the machine; planned again when it closes
      // Nobody sees a minimized or hidden window's progress view: rendered when it shows.
      const win = windows.get(id);
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized() || !win.isVisible()) {
        if (t.waitShow) return;
        t.waitShow = true;
        const shown = () => { win.off('show', shown); win.off('restore', shown); t.waitShow = false; plan(id); };
        win.on('show', shown);
        win.on('restore', shown);
        return;
      }
      render(id, 'main');
    }, Math.max(0, at - Date.now()));
  }

  // The agent's turn ended: every view, once, if anything changed since the last full render.
  // During Play it waits for the game to close (procExited).
  function panelTurnEnd(id) {
    const t = triggers.get(id);
    if (!t?.finalDirty) return false;
    clearTimeout(t.timer);
    t.timer = 0;
    if (playRunning(id)) { t.turnWhilePlaying = true; return false; }
    render(id, 'all');
    return true;
  }

  // One render at a time per session; a request during one runs after it ('all' wins).
  function render(id, kind) {
    const t = triggers.get(id);
    const s = panels.get(id);
    if (!t || !s?.watch) return;
    if (t.child || playRunning(id)) {
      t.pending = t.pending === 'all' || kind === 'all' ? 'all' : 'main';
      return;
    }
    const [exe, ...args] = s.watch.render;
    const started = Date.now();
    t.lastRun = started;
    t.changed = false;
    if (kind === 'all') { t.finalDirty = false; t.turnWhilePlaying = false; }
    let err = '';
    let child;
    try {
      child = spawn(exe, [...args, kind], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return log('error', 'panel.render', { id, kind, error: e.message }); }
    t.child = child;
    child.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    const done = (code, error) => {
      if (t.child !== child) return;
      t.child = null;
      log(code === 0 ? 'info' : 'warn', 'panel.render', { id, kind, ms: Date.now() - started, code, ...(code ? { error: (error || err).trim().slice(-300) } : {}) });
      const next = t.pending;
      t.pending = '';
      if (next && !playRunning(id)) render(id, next);
      else { if (next) t.pending = next; plan(id); }
    };
    child.on('error', (e) => done(-1, e.message));
    child.on('exit', (code) => done(code));
  }

  // ---- buttons -----------------------------------------------------------------------

  // Windows, \\wsl.localhost or WSL paths, as a Windows path.
  function panelPath(p) {
    p = String(p);
    if (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) return p.replace(/\//g, '\\');
    if (/^\/mnt\/[a-z]\//i.test(p)) return shared.wslToWin(p);
    if (p.startsWith('/')) return `\\\\wsl.localhost\\${settings.distro}${p.replace(/\//g, '\\')}`;
    throw new Error(`panel: "${p}" is not an absolute path`);
  }

  const argvOf = (list, what) => {
    if (!Array.isArray(list) || !list.length || list.some((x) => typeof x !== 'string') || !list[0]) {
      throw new Error(`panel: ${what} needs argv, a list of strings starting with the program`);
    }
    // A bare program name (`notepad.exe`) is found on the PATH.
    return [list[0].startsWith('/') ? panelPath(list[0]) : list[0], ...list.slice(1)];
  };

  function panelButtons(list) {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > 8) throw new Error('panel: buttons must be a list of at most 8');
    const seen = new Set();
    let plays = 0;
    return list.map((b, i) => {
      if (!b || typeof b !== 'object') throw new Error(`panel: button ${i} is not an object`);
      const id = String(b.id || '').trim();
      if (!id || seen.has(id) || /[\n/]/.test(id)) throw new Error(`panel: button ${i} needs a unique id without / or newlines`);
      seen.add(id);
      if (b.play && ++plays > 1) throw new Error('panel: only one button can be the play button');
      // argvFrom: a program run hidden on each press that prints the argv to start, as JSON (a fresh
      // run id, a packed draft); argv is then left out.
      const argvFrom = b.argvFrom ? argvOf(b.argvFrom, `button "${id}" argvFrom`) : null;
      return {
        id, label: String(b.label || id).slice(0, 40), argv: argvFrom ? null : argvOf(b.argv, `button "${id}"`), argvFrom, cwd: b.cwd ? panelPath(b.cwd) : '',
        single: !!b.single || !!b.play, play: !!b.play,
      };
    });
  }

  function panelWatchConfig(w) {
    if (w == null) return null;
    if (typeof w !== 'object' || Array.isArray(w)) throw new Error('panel: watch must be an object');
    const dirs = (Array.isArray(w.dirs) ? w.dirs : []).map(panelPath);
    if (!dirs.length || dirs.length > 8) throw new Error('panel: watch.dirs must list 1-8 folders');
    const ms = (x, def, min) => Math.max(min, Number.isFinite(Number(x)) ? Number(x) : def);
    return {
      dirs, render: argvOf(w.render, 'watch.render'),
      ignore: (Array.isArray(w.ignore) ? w.ignore : []).map(String).filter(Boolean).slice(0, 32),
      quietMs: ms(w.quietMs, 3000, 500), minGapMs: ms(w.minGapMs, 60000, 5000),
    };
  }

  async function panelSet(a) {
    const id = String(a.session || '');
    if (!id) throw new Error('panel: no session');
    // A windowless session keeps its panel for when a window opens on it.
    if (!windows.has(id)) await api('GET', `/sessions/${id}`);
    if (a.clear) {
      unwatchAll(id);
      panels.delete(id);
      panelsSave();
      sendPanel(id);
      log('info', 'panel.set', { id, clear: true });
      return { session: id, cleared: true };
    }
    const patch = a.panel;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('panel: --json must be an object');
    const prev = panels.get(id) || { image: '', version: 0, caption: '', views: '', watch: null, buttons: [] };
    const next = { ...prev };
    if ('image' in patch) next.image = patch.image ? panelPath(patch.image) : '';
    if ('caption' in patch) next.caption = patch.caption == null ? '' : String(patch.caption).slice(0, 200);
    if ('views' in patch) { next.views = patch.views ? panelPath(patch.views) : ''; next.manifest = null; next.versions = null; }
    if ('watch' in patch) next.watch = panelWatchConfig(patch.watch);
    if ('buttons' in patch) next.buttons = panelButtons(patch.buttons);
    next.version = next.image ? await mtime(next.image) : 0;
    panels.set(id, next);
    unwatchAll(id, true);
    watchAll(id);
    panelsSave();
    panelSweep();
    sendPanel(id);
    const keys = ['image', 'caption', 'views', 'watch', 'buttons'];
    const ignored = Object.keys(patch).filter((k) => !keys.includes(k));
    log('info', 'panel.set', { id, keys: Object.keys(patch), image: next.image, views: next.views, watch: next.watch?.dirs || null, buttons: next.buttons.map((b) => b.id), ...(ignored.length ? { ignored } : {}) });
    return { session: id, image: next.image, imageFound: !!next.version, views: next.views, watching: next.watch?.dirs || [], buttons: next.buttons.map((b) => b.id), window: windows.has(id), ...(ignored.length ? { ignored } : {}) };
  }

  // Kills a button's program, its child processes too, and waits up to 3s for it to go.
  function panelKill(id, button, proc) {
    if (proc.exited) return Promise.resolve();
    log('info', 'panel.kill', { id, button, pid: proc.pid, aliveMs: Date.now() - proc.at });
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      proc.child?.once('exit', () => { clearTimeout(t); resolve(); });
      execFile('taskkill.exe', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, (err) => {
        if (!proc.child) { proc.exited = true; clearTimeout(t); return resolve(); }
        if (err && !proc.exited) { try { proc.child.kill(); } catch {} }
      });
    });
  }

  function procExited(key, proc, info) {
    if (proc.done) return;
    proc.done = true;
    proc.exited = true;
    const [id, button] = key.split('\n');
    log('info', 'panel.exit', { id, button, pid: proc.pid, aliveMs: Date.now() - proc.at, ...info });
    if (procs.get(key) !== proc) return;
    // A game that ends with an error on its own (not a Stop press) says so in its cell.
    if (info.code && !proc.stopping && playButton(panels.get(id))?.id === button) {
      failures.set(key, `Program stopped with an error (code ${info.code})`);
    }
    sendPanel(id);
    panelsSave();
    // Renders put off while it ran: the turn's views, or a progress view of edits made meanwhile.
    const t = triggers.get(id);
    if (t && playButton(panels.get(id))?.id === button) {
      const kind = t.turnWhilePlaying || t.pending === 'all' ? 'all' : t.pending;
      t.pending = '';
      if (kind) render(id, kind);
      else plan(id);
    }
  }

  // The Play cell's second press closes the program, then kills it after 1s if needed.
  async function panelStop(id, button, proc) {
    const key = keyOf(id, button);
    const started = Date.now();
    proc.stopping = true;
    execFile('taskkill.exe', ['/pid', String(proc.pid), '/T'], { windowsHide: true }, () => {});
    await new Promise((resolve) => {
      if (proc.exited) return resolve();
      const t = setTimeout(resolve, 1000);
      proc.child?.once('exit', () => { clearTimeout(t); resolve(); });
    });
    const clean = proc.exited || (!proc.child && (await windowsPidImage(proc.pid)) !== proc.image);
    if (!clean) await panelKill(id, button, proc);
    if (!proc.child && procs.get(key) === proc && !proc.done) procExited(key, proc, { adopted: true });
    log('info', 'panel.stop', { id, button, ms: Date.now() - started, clean, via: 'close' });
    return { session: id, button, stopped: true, clean };
  }

  // cmd.exe's own quoting for .bat/.cmd files, which can't run without it.
  const cmdQuote = (s) => (/[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

  // Repeated presses share the pending start instead of queuing a stop behind it.
  const queue = new Map();
  function panelRun(id, button, via) {
    const key = keyOf(id, button);
    if (queue.has(key)) {
      log('info', 'panel.busy', { id, button, via, ms: Date.now() - (starting.get(key) || Date.now()) });
      return queue.get(key);
    }
    const prev = procs.get(key);
    if (!(prev && !prev.exited)) starting.set(key, Date.now());
    failures.delete(key);
    sendPanel(id);
    const run = panelStart(id, button, via);
    queue.set(key, run);
    run.catch((e) => {
      failures.set(key, String(e?.message || e).replace(/^panel: /, '').slice(0, 400));
    }).finally(() => {
      if (queue.get(key) === run) queue.delete(key);
      starting.delete(key);
      sendPanel(id);
    });
    return run;
  }

  // A Play build that runs longer than this is stuck (a cold build of every module takes ~50s).
  const ARGV_FROM_MS = 120000;
  function argvFromRun(id, b) {
    const started = Date.now();
    const [exe, ...args] = b.argvFrom;
    return new Promise((resolve, reject) => {
      execFile(exe, args, { windowsHide: true, timeout: ARGV_FROM_MS, maxBuffer: 1 << 20 }, (err, out, errOut) => {
        let argv = null;
        try { argv = JSON.parse(String(out).trim().split(/\r?\n/).pop()); } catch {}
        const ok = !err && Array.isArray(argv) && argv.length && argv.every((x) => typeof x === 'string');
        log(ok ? 'info' : 'error', 'panel.argv_from', { id, button: b.id, ms: Date.now() - started, ...(ok ? {} : { error: (err?.message || String(errOut || out)).trim().slice(-300) }) });
        if (err?.killed) return reject(new Error(`Build took over ${Math.round(ARGV_FROM_MS / 1000)}s and was stopped`));
        // Show the program's last error lines when it fails.
        if (!ok) return reject(new Error(String(errOut || out || err?.message || 'no argv').trim().split(/\r?\n/).slice(-4).join('\n') || `${b.id} failed to start`));
        resolve(argvOf(argv, `button "${b.id}" argvFrom output`));
      });
    });
  }

  async function panelStart(id, button, via) {
    const b = panels.get(id)?.buttons.find((x) => x.id === button);
    log('info', 'panel.click', { id, button, via });
    if (!b) {
      log('warn', 'panel.error', { id, button, error: 'no such button' });
      throw new Error(`panel: no button "${button}" in "${id}"`);
    }
    const key = keyOf(id, button);
    const prev = procs.get(key);
    if (b.play && prev && !prev.exited) return panelStop(id, button, prev);
    if (b.single && prev) await panelKill(id, button, prev);
    let [exe, ...args] = b.argvFrom ? await argvFromRun(id, b) : b.argv;
    // Detached (no console for console programs) and not hidden, so a game's window shows;
    // started by the foreground app, it may take the foreground.
    const opts = { cwd: b.cwd || undefined, detached: true, stdio: 'ignore', windowsHide: false };
    let child;
    try {
      child = /\.(bat|cmd)$/i.test(exe)
        ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[exe, ...args].map(cmdQuote).join(' ')}"`], { ...opts, windowsVerbatimArguments: true })
        : spawn(exe, args, opts);
    } catch (e) {
      log('error', 'panel.error', { id, button, exe, error: e.message });
      throw new Error(`panel: ${e.message}`);
    }
    const image = path.win32.basename(/\.(bat|cmd)$/i.test(exe) ? 'cmd.exe' : exe).toLowerCase();
    const proc = { child, pid: child.pid, image, at: Date.now(), exited: false };
    procs.set(key, proc);
    child.on('spawn', () => {
      log('info', 'panel.spawn', { id, button, pid: child.pid, exe, args: args.length, cwd: b.cwd || null });
      sendPanel(id);
      panelsSave();
      panelSweep();
    });
    child.on('error', (e) => {
      proc.exited = true;
      log('error', 'panel.error', { id, button, exe, error: e.message });
      sendPanel(id);
    });
    child.on('exit', (code, signal) => procExited(key, proc, { code, signal }));
    child.unref();
    // A missing exe or cwd fails asynchronously: report it to the caller instead of a pid-less success.
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(new Error(`panel: ${exe}: ${e.message}`)));
    });
    return { session: id, button, pid: child.pid };
  }

  ipcMain.on('panel:click', (e, button) => {
    const id = [...windows].find(([, w]) => !w.isDestroyed() && w.webContents === e.sender)?.[0];
    if (id) panelRun(id, String(button), 'click').catch(() => {});
  });

  // `r7shell panel --render main|all`: a render through the same one-at-a-time queue.
  function panelRender(id, kind) {
    if (!triggers.has(id)) throw new Error(`panel: "${id}" has no watch.render`);
    render(id, kind === 'main' ? 'main' : 'all');
    return { session: id, render: kind === 'main' ? 'main' : 'all', queued: !!triggers.get(id).pending || playRunning(id) };
  }

  return { panels, sendPanel, panelEnd, panelSet, panelRun, panelRender, panelsAdopt, panelTurnEnd, panelSweep };
};
