'use strict';
// Narrow bridge: window.MiqdarNative = { version, printers(), print(req), netPost(req) }. No fs/ipc/node exposed.
const { contextBridge, ipcRenderer } = require('electron');
// NOTE: sandboxed preloads cannot require() local files, so the origin rule is inlined here (same rule as lib/guard.js; test/preload.test.js checks both).
const BASE = ['miqdarerp.com'];
function isAllowedOrigin(o, opts) {
  let x; try { x = new URL(String(o)); } catch (e) { return false; }
  if (!/^https?:\/\/[^/]+$/.test(String(o))) return false;
  const h = x.hostname.toLowerCase();
  if (x.protocol === 'http:' && opts.dev && (h === 'localhost' || h === '127.0.0.1')) return true;
  if (x.protocol !== 'https:' || x.username || x.password) return false;
  return BASE.concat(opts.hosts).some(d => h === d || h.endsWith('.' + d));
}
const dev = process.env.MIQDAR_DEV === '1';
const hosts = (process.env.MIQDAR_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
if (isAllowedOrigin(location.origin, { dev, hosts })) {
  contextBridge.exposeInMainWorld('MiqdarNative', Object.freeze({
    version: ipcRenderer.sendSync('miqdar:version'),
    printers: () => ipcRenderer.invoke('miqdar:printers'),
    print: req => ipcRenderer.invoke('miqdar:print', req),
    netPost: req => ipcRenderer.invoke('miqdar:netpost', req),
  }));
}
