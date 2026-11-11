'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { resolveTarget, createPrinter, isVirtual } = require('../lib/printing');
const L = (...a) => a.map(([name, isDefault]) => ({ name, isDefault: !!isDefault, status: 0 }));
const real = L(['EPSON TM-T20', true], ['HP LaserJet'], ['Microsoft Print to PDF'], ['OneNote (Desktop)'], ['Zebra ZD220']);

test('virtual (PDF/OneNote/XPS/Fax) printers are detected', () => {
  for (const n of ['Microsoft Print to PDF', 'OneNote for Windows 10', 'Microsoft XPS Document Writer', 'Fax', 'CutePDF Writer', 'Adobe PDF']) assert.equal(isVirtual(n), true, n);
  for (const n of ['EPSON TM-T20', 'HP LaserJet Pro', 'Zebra ZD220', 'Star TSP143']) assert.equal(isVirtual(n), false, n);
});
test('resolveTarget: named, default, and the refusals that would otherwise pop a dialog', () => {
  assert.equal(resolveTarget('Zebra ZD220', real), 'Zebra ZD220');
  assert.equal(resolveTarget('', real), 'EPSON TM-T20');
  assert.throws(() => resolveTarget('', []), e => e.code === 'NO_PRINTERS');
  assert.throws(() => resolveTarget('', L(['HP'], ['Canon'])), e => e.code === 'NO_DEFAULT_PRINTER');
  assert.equal(resolveTarget('', L(['Only One'], ['Microsoft Print to PDF'])), 'Only One');
  assert.throws(() => resolveTarget('', L(['Microsoft Print to PDF', true], ['HP'])), e => e.code === 'DEFAULT_IS_VIRTUAL');
  assert.throws(() => resolveTarget('Microsoft Print to PDF', real), e => e.code === 'PRINTER_IS_VIRTUAL');
  assert.throws(() => resolveTarget('Nope', real), e => e.code === 'PRINTER_NOT_FOUND');
});
test('printJob: direct ok → no fallback; direct fails → PDF fallback; both fail → clear error; nothing is silently dropped', async () => {
  const p = createPrinter({ getPrinters: async () => real, platform: 'win32' }); const seen = [];
  let r = await p.printJob({ printer: '' }, { direct: async n => { seen.push('direct:' + n); }, pdf: async n => { seen.push('pdf:' + n); } });
  assert.deepEqual([r.ok, r.path, seen.join()], [true, 'direct', 'direct:EPSON TM-T20']);
  seen.length = 0; r = await p.printJob({ printer: 'HP LaserJet' }, { direct: async () => { throw new Error('boom'); }, pdf: async n => { seen.push('pdf:' + n); } });
  assert.deepEqual([r.ok, r.path, seen.join()], [true, 'pdf-fallback', 'pdf:HP LaserJet']);
  r = await p.printJob({ printer: '' }, { direct: async () => { throw new Error('boom'); }, pdf: async () => { throw new Error('nosumatra'); } });
  assert.equal(r.ok, false); assert.match(r.error, /boom/); assert.match(r.error, /nosumatra/);
  const called = []; r = await createPrinter({ getPrinters: async () => L(['Microsoft Print to PDF', true]), platform: 'win32' }).printJob({ printer: '' }, { direct: async () => called.push(1), pdf: async () => called.push(2) });
  assert.deepEqual([r.ok, r.code, called.length], [false, 'DEFAULT_IS_VIRTUAL', 0]);   // refused BEFORE any print call → no save dialog
});
test('diag: printers, default, virtual flags and the attempt log', async () => {
  const p = createPrinter({ getPrinters: async () => real, platform: 'win32' });
  await p.printJob({ printer: '' }, { direct: async () => {} }); await p.printJob({ printer: 'Zebra ZD220' }, { direct: async () => { throw new Error('x'); } });
  const d = await p.diag();
  assert.equal(d.defaultPrinter, 'EPSON TM-T20'); assert.equal(d.defaultIsVirtual, false); assert.equal(d.printers.filter(x => x.virtual).length, 2);
  assert.deepEqual(d.log.map(x => x.ok), [true, false]);
  const e = await createPrinter({ getPrinters: async () => [], platform: 'linux' }).diag(); assert.equal(e.noPrinters, true);
});
