'use strict';
// Runs preload.js in a vm with a fake sandbox-style require (only 'electron' allowed — local requires fail in a sandboxed preload, so none may exist).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
function run(origin, env) {
  const exposed = {};
  const ctx = { location: { origin }, process: { env: env || {} }, URL,
    require: m => { if (m !== 'electron') throw new Error('sandbox: cannot require ' + m);
      return { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { sendSync: () => '1.2.3', invoke: (ch, a) => Promise.resolve({ ch, a }) } }; } };
  vm.runInNewContext(src, ctx); return exposed;
}
test('preload exposes MiqdarNative only on allowed https origins', () => {
  const e = run('https://app.miqdarerp.com'); assert.ok(e.MiqdarNative);
  assert.deepEqual(Object.keys(e.MiqdarNative).sort(), ['netPost', 'print', 'printers', 'version']);
  assert.equal(e.MiqdarNative.version, '1.2.3');
  for (const o of ['https://evil.io', 'https://miqdarerp.com.evil.io', 'http://app.miqdarerp.com', 'null', 'file://', 'https://evilmiqdarerp.com']) assert.equal(run(o).MiqdarNative, undefined, o);
  assert.equal(run('http://localhost:8765').MiqdarNative, undefined);
  assert.ok(run('http://localhost:8765', { MIQDAR_DEV: '1' }).MiqdarNative);
  assert.ok(run('https://x.example.com', { MIQDAR_HOSTS: 'example.com' }).MiqdarNative);
});
test('preload matches lib/guard.js origin rule', () => {
  const g = require('../lib/guard');
  for (const o of ['https://app.miqdarerp.com', 'https://a.b.miqdarerp.com', 'https://miqdarerp.com', 'https://evil.io', 'http://miqdarerp.com', 'https://u:p@miqdarerp.com'])
    assert.equal(!!run(o).MiqdarNative, g.isAllowedOrigin(o), o);
});
