'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const g = require('../lib/guard');
const T = (f, m) => assert.throws(f, e => e.code === 'BAD_REQUEST' && (!m || e.message.includes(m)));

test('origin: only miqdar https domains', () => {
  for (const o of ['https://app.miqdarerp.com', 'https://miqdarerp.com', 'https://x.y.miqdarerp.com']) assert.equal(g.isAllowedOrigin(o), true, o);
  for (const o of ['http://app.miqdarerp.com', 'https://evilmiqdarerp.com', 'https://miqdarerp.com.evil.io', 'https://evil.io', 'null', '', 'https://user:p@app.miqdarerp.com', 'file:///x', 'javascript:alert(1)', undefined]) assert.equal(g.isAllowedOrigin(o), false, String(o));
  assert.equal(g.isAllowedOrigin('http://localhost:8787'), false);
  assert.equal(g.isAllowedOrigin('http://localhost:8787', { dev: true }), true);
  assert.equal(g.isAllowedOrigin('https://shop.example.com', { hosts: ['example.com'] }), true);
});
test('print: unknown types and bad shapes rejected', () => {
  for (const t of ['pdf', 'receipt', '', null, undefined, {}, 'INVOICE']) T(() => g.validatePrint({ type: t, html: 'x' }), 'type');
  T(() => g.validatePrint(null)); T(() => g.validatePrint([])); T(() => g.validatePrint('x'));
  T(() => g.validatePrint({ type: 'invoice' }), 'exactly one');
  T(() => g.validatePrint({ type: 'invoice', html: 'a', url: 'https://app.miqdarerp.com' }), 'exactly one');
});
test('print: size limits', () => {
  assert.equal(g.validatePrint({ type: 'invoice', html: 'x'.repeat(g.LIMITS.html) }).source, 'html');
  T(() => g.validatePrint({ type: 'invoice', html: 'x'.repeat(g.LIMITS.html + 1) }), 'html size');
  T(() => g.validatePrint({ type: 'a4', pdfBase64: 'A'.repeat(g.LIMITS.pdfB64 + 1) }), 'pdf');
  T(() => g.validatePrint({ type: 'a4', pdfBase64: 'not base64!!' }), 'pdf');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', copies: 0 }), 'copies');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', copies: 21 }), 'copies');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', copies: 'abc' }), 'copies');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', paper: { w_mm: 5, h_mm: 100 } }), 'w_mm');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', paper: { w_mm: 80, h_mm: 99999 } }), 'h_mm');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', paper: 'Letter' }), 'paper');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', margins: 999 }), 'margins');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', printer: 'a'.repeat(201) }), 'printer');
  T(() => g.validatePrint({ type: 'invoice', html: 'x', printer: 'a\u0000b' }), 'printer');
});
test('print: url source must be an allowed origin', () => {
  assert.equal(g.validatePrint({ type: 'a4', url: 'https://app.miqdarerp.com/p/1' }).url, 'https://app.miqdarerp.com/p/1');
  T(() => g.validatePrint({ type: 'a4', url: 'https://evil.io/x' }), 'url');
  T(() => g.validatePrint({ type: 'a4', url: 'file:///etc/passwd' }), 'url');
});
test('print: label never without a named printer; defaults normalised', () => {
  T(() => g.validatePrint({ type: 'label', html: 'x' }), 'NO_LABEL_PRINTER');
  T(() => g.validatePrint({ type: 'label', html: 'x', printer: '   ' }), 'NO_LABEL_PRINTER');
  const l = g.validatePrint({ type: 'label', html: 'x', printer: 'Zebra', paper: { w_mm: 50, h_mm: 25 }, copies: 3, margins: 0 });
  assert.deepEqual([l.printer, l.copies, l.paper.w_mm, l.margins.top], ['Zebra', 3, 50, 0]);
  const a = g.validatePrint({ type: 'a4', html: 'x' }); assert.equal(a.paper, 'A4'); assert.equal(a.copies, 1);
});
test('netPost: private LAN printers and fixed paths only', () => {
  const ok = g.validateNetPost({ url: 'http://192.168.1.50/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000', body: '<x/>' });
  assert.match(ok.url, /192\.168\.1\.50/);
  assert.equal(g.validateNetPost({ url: 'https://10.0.0.7:8043/cgi-bin/epos/service.cgi', body: 'x' }).url.startsWith('https://10.0.0.7'), true);
  assert.ok(g.validateNetPost({ url: 'http://172.16.0.9/StarWebPRNT/SendMessage', body: 'x' }));
  for (const u of ['http://8.8.8.8/cgi-bin/epos/service.cgi', 'http://localhost/cgi-bin/epos/service.cgi', 'http://172.32.0.1/cgi-bin/epos/service.cgi', 'http://192.168.1.5/admin', 'ftp://192.168.1.5/cgi-bin/epos/service.cgi', 'http://printer.local/cgi-bin/epos/service.cgi', 'http://169.254.169.254/cgi-bin/epos/service.cgi']) T(() => g.validateNetPost({ url: u, body: 'x' }));
  T(() => g.validateNetPost({ url: 'http://192.168.1.5/cgi-bin/epos/service.cgi', body: 'x'.repeat(g.LIMITS.netBody + 1) }), 'body');
});
