'use strict';
// Narrow bridge: window.MiqdarNative = { version, printers(), print(req), netPost(req) }. No fs/ipc/node exposed.
const { contextBridge, ipcRenderer, webFrame } = require('electron');
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
    api: 3,   // bridge level: the web feature-detects (printPage/raster/update) so a newer web never breaks an older shell
    update: () => ipcRenderer.invoke('miqdar:update'),
    restartForUpdate: () => ipcRenderer.invoke('miqdar:restart'),
    printers: () => ipcRenderer.invoke('miqdar:printers'),
    print: req => ipcRenderer.invoke('miqdar:print', req),
    netPost: req => ipcRenderer.invoke('miqdar:netpost', req),
    printPage: opts => ipcRenderer.invoke('miqdar:printPage', opts || {}),
    diag: () => ipcRenderer.invoke('miqdar:diag'),
  }));
  // Any window.print() from the page (the web app's last-resort path) must NEVER open the system dialog: redirect it to the silent main-process path.
  try { webFrame.executeJavaScript("(function(){var n=function(){var N=window.MiqdarNative;if(!N){return;}var p=N.printPage(window.__miqdarPrinter||'');p.then(function(r){if(r&&!r.ok){try{window.__miqdarPrintErr=r.error;window.dispatchEvent(new CustomEvent('miqdar-print-error',{detail:r.error}));}catch(e){}}});return p;};try{Object.defineProperty(window,'print',{value:n,writable:false,configurable:false});}catch(e){window.print=n;}})();"); } catch (e) {}
}
