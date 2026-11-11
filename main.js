'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, session } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), https = require('https');
const { isAllowedUrl, isAllowedOrigin, validatePrint, validateNetPost } = require('./lib/guard');

const DEV = process.env.MIQDAR_DEV === '1';
const EXTRA = (process.env.MIQDAR_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const OPTS = { dev: DEV, hosts: EXTRA };
const cfgFile = () => path.join(app.getPath('userData'), 'miqdar-config.json');   // non-secret prefs only
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch (e) { return {}; } };
const writeCfg = o => { try { fs.writeFileSync(cfgFile(), JSON.stringify({ ...readCfg(), ...o }, null, 1)); } catch (e) {} };
const startUrl = () => { const u = process.env.MIQDAR_URL || readCfg().url || 'https://app.miqdarerp.com'; return isAllowedUrl(u, OPTS) ? u : 'https://app.miqdarerp.com'; };

let win;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const senderOk = e => { try { return isAllowedOrigin(new URL(e.senderFrame.url).origin, OPTS) && e.senderFrame === e.sender.mainFrame; } catch (_) { return false; } };
const deny = () => { const e = new Error('origin not allowed'); e.code = 'ORIGIN'; throw e; };

function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 800, show: false, autoHideMenuBar: true, fullscreen: !!readCfg().fullscreen,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });   // external links → system browser
  win.webContents.on('will-navigate', (ev, url) => { if (!isAllowedUrl(url, OPTS)) { ev.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.loadURL(startUrl());
}

function buildMenu() {
  const c = readCfg();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'مقدار', submenu: [
    { label: 'شاشة كاملة', type: 'checkbox', checked: !!c.fullscreen, accelerator: 'F11', click: i => { writeCfg({ fullscreen: i.checked }); win && win.setFullScreen(i.checked); } },
    { label: 'تشغيل مع ويندوز', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: i => { writeCfg({ autostart: i.checked }); app.setLoginItemSettings({ openAtLogin: i.checked }); } },
    { label: 'إعادة تحميل', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
    { type: 'separator' }, { role: 'quit', label: 'خروج' } ] }]));
}

// ---- IPC (every handler re-checks the calling frame's origin) ----
ipcMain.on('miqdar:version', e => { e.returnValue = senderOk(e) ? app.getVersion() : ''; });
ipcMain.handle('miqdar:printers', async e => {
  if (!senderOk(e)) deny();
  const list = await e.sender.getPrintersAsync();
  return list.map(p => ({ name: String(p.name), isDefault: !!p.isDefault, status: Number(p.status) || 0 }));
});

function hiddenWin() { return new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, offscreen: false } }); }
const mmToMicrons = v => Math.round(v * 1000);
function printOpts(r) {
  const o = { silent: true, printBackground: true, copies: r.copies };
  if (r.printer) o.deviceName = r.printer;
  if (r.paper === 'A4') o.pageSize = 'A4';
  else if (r.paper) o.pageSize = { width: mmToMicrons(r.paper.w_mm), height: mmToMicrons(r.paper.h_mm) };
  const px = mm => Math.round(mm * 96 / 25.4);   // Electron custom margins are in pixels
  if (r.margins) { o.margins = { marginType: 'custom', top: px(r.margins.top), right: px(r.margins.right), bottom: px(r.margins.bottom), left: px(r.margins.left) }; }
  else o.margins = { marginType: 'none' };
  return o;
}
function wcPrint(wc, o) { return new Promise((res, rej) => wc.print(o, (ok, why) => ok ? res() : rej(new Error(why || 'print failed')))); }

ipcMain.handle('miqdar:print', async (e, raw) => {
  if (!senderOk(e)) deny();
  let r; try { r = validatePrint(raw, OPTS); } catch (err) { return { ok: false, error: err.message }; }
  if (r.printer) { const names = (await e.sender.getPrintersAsync()).map(p => p.name); if (!names.includes(r.printer)) return { ok: false, error: 'PRINTER_NOT_FOUND: ' + r.printer }; }
  let w;
  try {
    if (r.source === 'pdfBase64') {
      const pdf = require('pdf-to-printer'); const f = path.join(os.tmpdir(), 'miqdar-' + Date.now() + '.pdf');
      fs.writeFileSync(f, Buffer.from(r.pdfBase64, 'base64'));
      try { await pdf.print(f, { printer: r.printer || undefined, copies: r.copies, scale: 'fit' }); } finally { fs.unlink(f, () => {}); }
      return { ok: true };
    }
    w = hiddenWin();
    if (r.source === 'html') await w.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(r.html, 'utf8').toString('base64'));
    else await w.loadURL(r.url);
    await wcPrint(w.webContents, printOpts(r));
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err).slice(0, 200) }; }
  finally { if (w && !w.isDestroyed()) w.destroy(); }
});

// LAN printer POST from the main process: no mixed-content block, and a self-signed printer certificate is accepted ONLY for this validated private IP.
ipcMain.handle('miqdar:netpost', async (e, raw) => {
  if (!senderOk(e)) deny();
  let r; try { r = validateNetPost(raw); } catch (err) { return { ok: false, error: err.message }; }
  return new Promise(resolve => {
    const u = new URL(r.url), lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', timeout: 12000, rejectUnauthorized: false, headers: { 'Content-Type': r.contentType, 'Content-Length': Buffer.byteLength(r.body), ...(r.soapAction ? { SOAPAction: r.soapAction } : {}) } }, res => {
      let d = ''; res.setEncoding('utf8'); res.on('data', c => { if (d.length < 65536) d += c; }); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', er => resolve({ ok: false, error: String(er.message).slice(0, 160) }));
    req.end(r.body);
  });
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));   // no camera/mic/geo etc.
  if (readCfg().autostart != null) app.setLoginItemSettings({ openAtLogin: !!readCfg().autostart });
  buildMenu(); createWindow();
  if (app.isPackaged) { try { const { autoUpdater } = require('electron-updater'); autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch (_) {} }
});
app.on('window-all-closed', () => app.quit());
