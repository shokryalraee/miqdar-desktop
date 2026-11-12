'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('events');
const { createUpdater } = require('../lib/updater');
const fake = () => { const a = new EventEmitter(); a.calls = 0; a.quit = null; a.checkForUpdates = async () => { a.calls++; a.emit('checking-for-update'); return a.next ? a.next() : a.emit('update-not-available'); }; a.quitAndInstall = (s, r) => { a.quit = [s, r]; }; return a; };
test('silent by construction: autoDownload + install on quit, no logger, downgrade off', () => {
  const a = fake(); createUpdater({ autoUpdater: a }); assert.deepEqual([a.autoDownload, a.autoInstallOnAppQuit, a.allowDowngrade, a.logger], [true, true, false, null]);
});
test('start checks immediately and every interval; available → downloading → ready; ready stops re-checking', async () => {
  const a = fake(), ticks = []; const u = createUpdater({ autoUpdater: a, intervalMs: 1234, setIntervalFn: (fn, ms) => { ticks.push([fn, ms]); return { unref() {} }; } });
  u.start(); await new Promise(r => setImmediate(r)); assert.equal(a.calls, 1); assert.equal(ticks[0][1], 1234);
  a.next = () => { a.emit('update-available', { version: '1.1.3' }); a.emit('update-downloaded', { version: '1.1.3' }); };
  await ticks[0][0](); assert.deepEqual([u.state().status, u.state().version], ['ready', '1.1.3']);
  const n = a.calls; await u.check(); assert.equal(a.calls, n);
  assert.equal(u.restart(), true); assert.deepEqual(a.quit, [true, true]);
});
test('default interval is 4 hours; errors are swallowed (no throw, state idle with message)', async () => {
  const a = fake(), ticks = []; const u = createUpdater({ autoUpdater: a, setIntervalFn: (fn, ms) => { ticks.push(ms); return {}; } }); u.start(); assert.equal(ticks[0], 4 * 3600 * 1000);
  a.checkForUpdates = async () => { throw new Error('404 latest.yml'); }; await u.check(); assert.equal(u.state().status, 'idle'); assert.match(u.state().error, /404/);
  a.emit('error', new Error('net')); assert.equal(u.restart(), false);
});
test('restart only when an update is ready; a later error does not lose the ready update', async () => {
  const a = fake(); const u = createUpdater({ autoUpdater: a }); assert.equal(u.restart(), false);
  a.emit('update-downloaded', { version: '2.0.0' }); a.emit('error', new Error('x')); assert.equal(u.state().status, 'ready');
});
