'use strict';
// Draw the working ring over the input box's spinner and publish r7-busy changes.
(() => {
  const el = document.createElement('div');
  el.className = 'r7-loader';
  el.hidden = true;
  const cover = document.createElement('span');
  cover.className = 'r7-loader-cover';
  const ring = document.createElement('span');
  ring.className = 'r7-ring';
  el.append(cover, ring);
  screenEl.appendChild(el);

  let layoutKey = '', working = false;
  window.r7Busy = false;

  function cellBg(cell) {
    if (cell.isBgRGB()) return '#' + cell.getBgColor().toString(16).padStart(6, '0');
    if (cell.isBgPalette()) return colors.palette[cell.getBgColor()] || colors.bg;
    return colors.bg;
  }

  // The first braille spinner / ◊ / π / nerd-font π (U+F0D57) on the box's top border, near its left corner.
  function readSlot() {
    const box = findBox();
    if (!box) return null;
    const b = term.buffer.active;
    const line = b.getLine(b.viewportY + box.top);
    if (!line) return null;
    const last = Math.min(box.right - 1, box.left + 16, term.cols - 1);
    for (let x = box.left + 1; x <= last; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const chars = cell.getChars();
      if (!chars) continue;
      const cp = chars.codePointAt(0);
      const braille = cp >= 0x2801 && cp <= 0x28ff;
      if (!braille && chars !== '◊' && chars !== 'π' && cp !== 0xF0D57) continue;
      const blank = (i) => { const c = line.getCell(i); const ch = c ? c.getChars() : ' '; return !ch || ch === ' '; };
      const width = Math.max(1, cell.getWidth());
      return { row: box.top, x, width, working: braille, bg: cellBg(cell), roomBoth: blank(x - 1) && blank(x + width) };
    }
    return null;
  }

  function setBusy(on) {
    if (working === on) return;
    working = on;
    window.r7Busy = on;
    r7.log('info', on ? 'loader.start' : 'loader.stop', { session: cfg.session });
    window.dispatchEvent(new Event('r7-busy'));
  }

  // Covers the glyph's own cell in that cell's background; the ring may reach a little past it.
  function place(slot) {
    const cw = cellWidth(), ch = rowHeight();
    const covered = slot.width * cw;
    const room = slot.roomBoth ? covered + 2 * cw : covered;
    // Fit inside the status bar's row height.
    const D = Math.round(Math.min(0.78 * ch, Math.max(covered, room - 1)));
    const W = Math.max(D, Math.ceil(covered) + 2), H = Math.max(D, Math.ceil(ch));
    const left = Math.round((slot.x + slot.width / 2) * cw - W / 2);
    const top = Math.round((slot.row + 0.5) * ch - H / 2);
    const key = `${W}|${H}|${D}|${left}|${top}|${slot.bg}|${colors.cursor}`;
    if (key !== layoutKey) {
      layoutKey = key;
      Object.assign(el.style, { width: `${W}px`, height: `${H}px`, left: `${left}px`, top: `${top}px`, color: colors.cursor || colors.fg });
      Object.assign(cover.style, { width: `${covered + 1}px`, height: `${ch}px`, left: `${(W - covered) / 2 - 0.5}px`, top: `${(H - ch) / 2}px`, background: slot.bg });
      ring.style.setProperty('--tk', `${D}px`);
    }
    el.style.translate = `0 ${window.r7RowMotion?.(slot.row) || 0}px`;
    el.hidden = false;
  }

  function update() {
    const slot = document.hidden ? null : readSlot();
    // A hidden window keeps its last known state; only a visible screen decides busy or idle.
    if (!slot) { el.hidden = true; if (!document.hidden && findBox()) setBusy(false); return; }
    setBusy(slot.working);
    if (slot.working) place(slot);
    else el.hidden = true;
  }

  term.onRender(update);
  // The box slides with the rows above it (motion.js); the ring follows.
  window.addEventListener('r7-row-motion', () => { if (!el.hidden) el.style.translate = `0 ${window.r7RowMotion?.(findBox()?.top ?? 0) || 0}px`; });
  term.onResize(() => { layoutKey = ''; });
  document.addEventListener('visibilitychange', update);
})();
