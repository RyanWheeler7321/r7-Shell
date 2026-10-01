'use strict';
// Starter for a full-screen r7Shell app: alternate screen, resize, keys, mouse.
// Arrow keys or WASD move the @, clicking puts it there, q quits.
// Copy this file, add a template pointing at it, and build from here.

const out = process.stdout;
let x = 10;
let y = 5;
let last = 'nothing yet';

function draw() {
  const w = out.columns;
  const h = out.rows;
  x = Math.max(1, Math.min(w - 2, x));
  y = Math.max(2, Math.min(h - 3, y));
  let frame = '\x1b[H\x1b[2J';
  frame += `\x1b[1;1H\x1b[38;2;240;220;255mr7Shell example · ${w}x${h} · last input: ${last}\x1b[0m`;
  frame += `\x1b[${h};1H\x1b[2marrows/WASD move · click to place · q quits\x1b[0m`;
  frame += `\x1b[${y + 1};${x + 1}H\x1b[38;2;255;61;154m@\x1b[0m`;
  out.write(frame);
}

// One read can hold several keys (fast typing, pastes), so split it into tokens.
const TOKENS = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[A-D]|\x1bO[A-D]|[\s\S]/g;

function onInput(data) {
  for (const token of data.toString().match(TOKENS) || []) onKey(token);
  draw();
}

function onKey(s) {
  const mouse = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouse) {
    if (mouse[4] === 'M' && mouse[1] === '0') { x = Number(mouse[2]) - 1; y = Number(mouse[3]) - 1; last = `click ${x},${y}`; }
  } else if (s === 'q' || s === '\x03') {
    return quit();
  } else {
    const moves = { '\x1b[A': [0, -1], w: [0, -1], '\x1b[B': [0, 1], s: [0, 1], '\x1b[D': [-1, 0], a: [-1, 0], '\x1b[C': [1, 0], d: [1, 0] };
    const m = moves[s];
    if (m) { x += m[0]; y += m[1]; }
    last = JSON.stringify(s);
  }
}

function quit() {
  out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
  process.exit(0);
}

out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
process.stdin.setRawMode(true);
process.stdin.on('data', onInput);
out.on('resize', draw);
draw();
