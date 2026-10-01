'use strict';
// ---- window.r7shell --------------------------------------------------------------
// How a program or an extras script tells the window about an agent: its turn
// finished (attention glow), media to pin, and r7Harness input-box features.
//
//   r7shell.attention({ phase, completedMs, seen })  phase 'waiting' = turn finished
//   r7shell.done()                                    same as a turn finishing now
//   r7shell.setPins(entries, revision)                [{ id, media: [{ path, kind, name }] }], newest first
//   r7shell.setMouseEditing(on)                       mouse selection in the input box
//   r7shell.enableHarness()                           r7Harness features for this window
//
// A turn also finishes on a bell, OSC 9 / OSC 777 notifications, OSC 7321 `done`
// and `r7shell done`. OSC 7321 `hello` (or a template's `r7harness`) turns on the
// r7Harness features: task title row, mouse editing, a redraw on reattach.

const harness = { on: !!cfg.r7harness, mouseEditing: !!cfg.r7harness };
const attentionListeners = [];
const pinListeners = [];
// Set by done() and the terminal's own signals, so typing clears it again.
let localAttention = false;

window.r7shell = {
  attention(data = {}) {
    localAttention = false;
    for (const fn of attentionListeners) fn({ phase: data.phase || '', completedMs: data.completedMs || 0, seen: !!data.seen });
  },
  done() {
    window.r7shell.attention({ phase: 'waiting', completedMs: Date.now(), seen: false });
    localAttention = true;
  },
  setPins(entries, revision) {
    for (const fn of pinListeners) fn(entries || [], revision || '');
  },
  setMouseEditing(on) {
    harness.mouseEditing = !!on;
  },
  enableHarness() {
    if (harness.on) return;
    harness.on = true;
    harness.mouseEditing = true;
    r7.log('info', 'harness.on', { session: cfg.session });
  },
};

term.onBell(() => window.r7shell.done());
// OSC 9 is a notification, except ConEmu's numbered commands (9;4 is progress).
term.parser.registerOscHandler(9, (data) => {
  if (!/^\d+(;|$)/.test(data)) window.r7shell.done();
  return true;
});
term.parser.registerOscHandler(777, (data) => {
  if (data.split(';')[0] === 'notify') window.r7shell.done();
  return true;
});
// Other OSC 7321 marks (titles, pictures) are marks.js's.
term.parser.registerOscHandler(7321, (data) => {
  const kind = data.split(';')[0];
  if (kind === 'done') { window.r7shell.done(); return true; }
  if (kind === 'hello') { window.r7shell.enableHarness(); return true; }
  return false;
});

// The window's own signals end when you type into it again.
term.onData(() => {
  if (localAttention) window.r7shell.attention({ phase: '' });
});

r7.onDone?.(() => window.r7shell.done());
r7.onPins?.((entries) => window.r7shell.setPins(entries));
