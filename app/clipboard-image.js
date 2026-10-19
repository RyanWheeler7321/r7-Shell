'use strict';
const { deflate, crc32 } = require('node:zlib');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const compress = promisify(deflate);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const transfers = new Map();

function chunk(name, data) {
  const type = Buffer.from(name);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  type.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(data, crc32(type)));
  return [header, data, checksum];
}

// Windows NativeImage bitmaps are premultiplied BGRA. Opaque screenshots need only
// a channel swap, avoiding Skia's slow PNG compression without losing any pixels.
async function encodeBitmap(bitmap, width, height) {
  if (bitmap.length !== width * height * 4) throw new Error('Clipboard bitmap size does not match its dimensions');
  const stride = width * 4;
  const rowBytes = width * 3 + 1;
  const rows = Buffer.allocUnsafe(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const source = y * stride;
    const target = y * rowBytes;
    rows[target] = 1;
    for (let x = 0; x < stride; x += 4) {
      // Preserve native alpha conversion for transparent images.
      if (bitmap[source + x + 3] !== 255) return null;
      const at = target + x / 4 * 3 + 1;
      rows[at] = bitmap[source + x + 2] - (x ? bitmap[source + x - 2] : 0);
      rows[at + 1] = bitmap[source + x + 1] - (x ? bitmap[source + x - 3] : 0);
      rows[at + 2] = bitmap[source + x] - (x ? bitmap[source + x - 4] : 0);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = await compress(rows, { level: 1 });
  return Buffer.concat([signature, ...chunk('IHDR', header), ...chunk('IDAT', pixels), ...chunk('IEND', Buffer.alloc(0))]);
}

async function encodeImage(image) {
  const { width, height } = image.getSize();
  const fast = process.platform === 'win32' ? await encodeBitmap(image.toBitmap(), width, height) : null;
  return { bytes: fast || image.toPNG(), width, height, encoder: fast ? 'fast-png' : 'native-png' };
}

function waitForPickup(file) {
  let info;
  try { info = fs.statSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return Promise.resolve();
    throw error;
  }
  const remaining = 5000 - (Date.now() - info.mtimeMs);
  if (remaining <= 0) {
    fs.rmSync(file, { force: true });
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve();
    };
    const check = () => { if (!fs.existsSync(file)) finish(); };
    const watcher = fs.watch(path.dirname(file), check);
    const timer = setTimeout(() => finish(fs.existsSync(file) ? new Error('The previous image paste was not received') : undefined), remaining);
    watcher.once('error', finish);
    check();
  });
}

async function saveImage(image, file) {
  const previous = transfers.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await waitForPickup(file);
    const start = performance.now();
    const result = await encodeImage(image);
    const encoded = performance.now();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, result.bytes);
    return { ...result, encodeMs: Math.round(encoded - start), writeMs: Math.round(performance.now() - encoded) };
  });
  transfers.set(file, operation);
  try { return await operation; }
  finally { if (transfers.get(file) === operation) transfers.delete(file); }
}

module.exports = { encodeBitmap, encodeImage, saveImage };
