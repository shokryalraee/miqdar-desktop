'use strict';
// Narrow bridge: window.MiqdarNative = { version, printers(), print(req), netPost(req) }. No fs/ipc/node exposed.
const { contextBridge, ipcRenderer } = require('electron');
const { isAllowedOrigin } = require('./lib/guard');
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
