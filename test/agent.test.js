'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('http');
const { createAgent } = require('../lib/agent-core');
const OK = 'https://app.miqdarerp.com';
function mk(over) {
  const st = {}; const calls = [];
  const a = createAgent({ version: '9.9', originOpts: { hosts: ['shop.example.com'] }, retryMs: 5, waitMs: 3000,
    getPrinters: async () => [{ name: 'EPSON TM-T88V', isDefault: true, status: 0, virtual: false }],
    execute: over && over.execute || (async spec => { calls.push(spec); return { path: 'direct', printer: spec.printer || 'EPSON TM-T88V' }; }),
    store: { get: () => st, set: o => Object.assign(st, o) } });
  return { a, st, calls };
}
const call = (port, method, path, { origin = OK, token, body, host } = {}) => new Promise((res, rej) => {
  const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = { Host: host || '127.0.0.1:' + port }; if (origin) h.Origin = origin; if (token) h.Authorization = 'Bearer ' + token; if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, s => { let b = ''; s.on('data', c => b += c); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, headers: s.headers, json: j }); }); });
  r.on('error', rej); if (data) r.write(data); r.end();
});
async function boot(over) { const m = mk(over); const port = await m.a.start(); const code = m.a.code(); const r = await call(port, 'POST', '/pair', { body: { code } }); return { ...m, port, token: r.json.token }; }

test('origin / host gates: foreign origin, no origin, bad Host (DNS rebinding) are refused before anything else', async () => {
  const m = mk(); const port = await m.a.start();
  for (const o of ['https://evil.io', 'http://app.miqdarerp.com', 'https://miqdarerp.com.evil.io', null]) { const r = await call(port, 'GET', '/status', { origin: o }); assert.equal(r.status, 403, String(o)); assert.equal(r.headers['access-control-allow-origin'], undefined); }
  assert.equal((await call(port, 'GET', '/status', { host: 'evil.io' })).status, 421);
  assert.equal((await call(port, 'GET', '/status')).status, 200);
  assert.equal((await call(port, 'GET', '/status', { origin: 'https://shop.example.com' })).status, 200);   // registered shop domain
  m.a.stop();
});
test('CORS + Private Network Access preflight', async () => {
  const m = mk(); const port = await m.a.start(); const r = await call(port, 'OPTIONS', '/print');
  assert.equal(r.status, 204); assert.equal(r.headers['access-control-allow-origin'], OK); assert.equal(r.headers['access-control-allow-private-network'], 'true'); assert.match(r.headers['access-control-allow-headers'], /Authorization/);
  m.a.stop();
});
test('pairing: wrong code refused, lockout after 5 failures, right code issues a token bound to the origin, code rotates', async () => {
  const m = mk(); const port = await m.a.start(); const code = m.a.code();
  for (let i = 0; i < 4; i++) assert.equal((await call(port, 'POST', '/pair', { body: { code: '000000' === code ? '111111' : '000000' } })).status, 401);
  assert.equal((await call(port, 'POST', '/pair', { body: { code: '000000' === code ? '111111' : '000000' } })).status, 401);
  assert.equal((await call(port, 'POST', '/pair', { body: { code } })).status, 429);   // locked even with the right code
  m.a.stop();
  const b = await boot(); assert.ok(b.token.length >= 40); assert.equal(b.st.agentTokens.length, 1); assert.notEqual(b.st.agentTokens[0].h, b.token);   // only the hash is stored
  assert.equal((await call(b.port, 'GET', '/status', { token: b.token })).json.paired, true);
  assert.equal((await call(b.port, 'GET', '/printers', { token: b.token, origin: 'https://shop.example.com' })).status, 401);   // token bound to its origin
  assert.equal((await call(b.port, 'POST', '/pair', { body: { code: b.a.code() === 'x' ? '' : '123' } })).status, 401);
  b.a.stop();
});
test('no token → 401 on printers/print/jobs; token works; revokeAll kills it', async () => {
  const b = await boot();
  for (const [m, p] of [['GET', '/printers'], ['POST', '/print'], ['GET', '/jobs']]) assert.equal((await call(b.port, m, p, { body: m === 'POST' ? {} : undefined })).status, 401);
  const r = await call(b.port, 'GET', '/printers', { token: b.token }); assert.equal(r.status, 200); assert.equal(r.json.printers[0].name, 'EPSON TM-T88V');
  b.a.revokeAll(); assert.equal((await call(b.port, 'GET', '/printers', { token: b.token })).status, 401); b.a.stop();
});
test('print: html / pdf / escpos-raw accepted and executed; label needs a named printer; bad type/size rejected', async () => {
  const b = await boot(); const P = body => call(b.port, 'POST', '/print', { token: b.token, body });
  let r = await P({ type: 'html', docType: 'invoice', data: '<b>x</b>', printer: 'EPSON TM-T88V', width_mm: 80, height_mm: 200, copies: 2 }); assert.deepEqual([r.status, r.json.ok, r.json.status, r.json.path], [200, true, 'done', 'direct']);
  assert.deepEqual([b.calls[0].kind, b.calls[0].copies, b.calls[0].paper.w_mm], ['html', 2, 80]);
  r = await P({ type: 'html', docType: 'invoice', data: '<b>x</b>', mode: 'raster', dots: 576 }); assert.equal(b.calls[1].raster.dots, 576);
  r = await P({ type: 'pdf', docType: 'a4', data: Buffer.from('%PDF-1.4').toString('base64'), pageSize: 'A4', printer: 'HP' }); assert.equal(r.status, 200); assert.equal(b.calls[2].kind, 'pdf');
  r = await P({ type: 'escpos-raw', docType: 'label', data: Buffer.from('SIZE 50 mm,25 mm\r\nPRINT 1\r\n').toString('base64'), printer: 'TSC TTP-244' }); assert.equal(r.json.ok, true); assert.equal(b.calls[3].kind, 'raw'); assert.equal(b.calls[3].bytes.length, 'SIZE 50 mm,25 mm\r\nPRINT 1\r\n'.length);
  assert.equal((await P({ type: 'escpos-raw', data: 'AAAA' })).status, 400);                                  // raw without a printer name
  assert.equal((await P({ type: 'html', docType: 'label', data: 'x' })).status, 400);                          // label without a printer (guard)
  assert.equal((await P({ type: 'html', docType: 'weird', data: 'x' })).status, 400);
  assert.equal((await P({ type: 'exe', data: 'x' })).status, 400);
  assert.equal((await P({ type: 'html', data: 'x'.repeat(5 * 1024 * 1024 + 1) })).status, 400);
  assert.equal((await P({ type: 'html', data: 'x', baseUrl: 'https://evil.io' })).status, 400);
  assert.equal((await P({ type: 'html', data: 'x', baseUrl: 'https://app.miqdarerp.com' })).json.ok, true);
  b.a.stop();
});
test('queue: sequential; transient failures retried 2×; permanent errors are not; job status + history', async () => {
  let n = 0, order = []; const b = await boot({ execute: async spec => { order.push(spec.printer); if (spec.printer === 'FLAKY' && ++n < 3) throw new Error('RAW: spooler busy'); if (spec.printer === 'GONE') throw new Error('PRINTER_NOT_FOUND: GONE'); return { path: 'direct', printer: spec.printer }; } });
  const P = body => call(b.port, 'POST', '/print', { token: b.token, body });
  let r = await P({ type: 'html', data: 'x', printer: 'FLAKY' }); assert.deepEqual([r.json.ok, r.json.attempts], [true, 3]);
  r = await P({ type: 'html', data: 'x', printer: 'GONE' }); assert.deepEqual([r.status, r.json.ok, r.json.attempts], [502, false, 1]); assert.match(r.json.error, /NOT_FOUND/);
  const j = await call(b.port, 'GET', '/jobs/' + r.json.id, { token: b.token }); assert.equal(j.json.status, 'error');
  const list = await call(b.port, 'GET', '/jobs', { token: b.token }); assert.equal(list.json.jobs.length, 2);
  const w = await P({ type: 'html', data: 'x', printer: 'A', wait: false }); assert.ok(w.json.id);   // no wait → returns the job id immediately
  b.a.stop();
});
