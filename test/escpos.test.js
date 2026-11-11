'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const e = require('../lib/escpos');
const bgra = (w, h, f) => { const b = Buffer.alloc(w * h * 4, 255); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (f(x, y)) { const i = (y * w + x) * 4; b[i] = b[i + 1] = b[i + 2] = 0; } return b; };
test('toMono: MSB-first, black=1, row stride ceil(w/8)', () => {
  const m = e.toMono(bgra(10, 2, (x, y) => x === 0 || (y === 1 && x === 9)), 10, 2);
  assert.equal(m.bytesPerRow, 2); assert.deepEqual([...m.data], [0x80, 0x00, 0x80, 0x40]);
});
test('transparent pixels are paper (white)', () => { const b = Buffer.alloc(8 * 4); const m = e.toMono(b, 8, 1); assert.equal(m.data[0], 0); });
test('buildReceipt: init, GS v 0 bands of ≤128 rows, feed, cut; round-trips through decode at exactly 576 dots', () => {
  const W = 576, H = 300, src = bgra(W, H, (x, y) => (x + y) % 7 === 0), m = e.toMono(src, W, H);
  const buf = e.buildReceipt(m, W, H, 1);
  assert.deepEqual([...buf.subarray(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...buf.subarray(2, 10)], [0x1d, 0x76, 0x30, 0x00, 72, 0, 128, 0]);   // 576/8=72 bytes/row, first band 128 rows
  assert.deepEqual([...buf.subarray(buf.length - 4)], [0x1d, 0x56, 0x42, 0x00]);
  const d = e.decode(buf); assert.equal(d.width, 576); assert.equal(d.height, H);
  assert.equal(Buffer.compare(Buffer.concat(d.rows), m.data), 0);
});
test('copies repeat the whole receipt; width limits enforced', () => {
  const m = e.toMono(bgra(384, 4, () => true), 384, 4);
  assert.equal(e.buildReceipt(m, 384, 4, 3).length, 3 * e.buildReceipt(m, 384, 4, 1).length);
  assert.throws(() => e.buildReceipt(m, 100, 4, 1), /dots/); assert.throws(() => e.buildReceipt(m, 2000, 4, 1), /dots/);
});
test('looksThermal: Epson TM/XP/POS yes; laser/PDF/Star no', () => {
  for (const n of ['EPSON TM-T88V Receipt', 'EPSON TM-T88VI', 'TM-T20II', 'Epson TM-m30', 'XP-80C', 'POS-80', 'Receipt Printer', 'Generic / Text Only thermal']) assert.equal(e.looksThermal(n), true, n);
  for (const n of ['HP LaserJet Pro', 'Zebra ZD220', 'Microsoft Print to PDF', 'Star TSP143', 'Canon MG3600']) assert.equal(e.looksThermal(n), false, n);
});
