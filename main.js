'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, session } = require('electron');
const { execFile } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), https = require('https');
const { createPrinter, isVirtual } = require('./lib/printing');
const { isAllowedUrl, isAllowedOrigin, validatePrint, validateNetPost } = require('./lib/guard');

const DEV = process.env.MIQDAR_DEV === '1';
const EXTRA = (process.env.MIQDAR_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const OPTS = { dev: DEV, hosts: EXTRA };
const cfgFile = () => path.join(app.getPath('userData'), 'miqdar-config.json');   // non-secret prefs only
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch (e) { return {}; } };
const writeCfg = o => { try { fs.writeFileSync(cfgFile(), JSON.stringify({ ...readCfg(), ...o }, null, 1)); } catch (e) {} };
const startUrl = () => { const u = process.env.MIQDAR_URL || readCfg().url || 'https://app.miqdarerp.com'; return isAllowedUrl(u, OPTS) ? u : 'https://app.miqdarerp.com'; };

let win;
if (process.platform === 'win32') app.setAppUserModelId('com.miqdarerp.cashier');   // proper Windows identity (taskbar / notifications)
const ICON = path.join(__dirname, 'build', 'icon.png');
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const senderOk = e => { try { return isAllowedOrigin(new URL(e.senderFrame.url).origin, OPTS) && e.senderFrame === e.sender.mainFrame; } catch (_) { return false; } };
const deny = () => { const e = new Error('origin not allowed'); e.code = 'ORIGIN'; throw e; };

function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 800, show: false, autoHideMenuBar: true, icon: ICON, fullscreen: !!readCfg().fullscreen,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.webContents.on('before-input-event', (ev, input) => { if ((input.control || input.meta) && !input.alt && String(input.key).toLowerCase() === 'p' && input.type === 'keyDown') { ev.preventDefault(); printCurrentPage(win.webContents, '').then(r => { if (!r.ok && win && !win.isDestroyed()) win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("miqdar-print-error",{detail:' + JSON.stringify(String(r.error || '')) + '}))').catch(() => {}); }); } });   // Ctrl/Cmd+P → silent path, no dialog
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });   // external links → system browser
  win.webContents.on('will-navigate', (ev, url) => { if (!isAllowedUrl(url, OPTS)) { ev.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  // offline / unreachable: a calm local page with retry (never a blank window or an error box)
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => { if (!isMain || code === -3) return;
    const page = '<meta charset=utf-8><body style="font:16px system-ui;text-align:center;padding:12vh 20px;direction:rtl"><h2>لا يوجد اتصال بالإنترنت</h2><p>تأكد من الشبكة ثم أعد المحاولة.<br>No internet connection.</p><button style="font-size:16px;padding:8px 22px" onclick="location.href=\''+String(url).replace(/[\\\'"<>]/g, '')+'\'">إعادة المحاولة / Retry</button></body>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page)); });
  win.loadURL(startUrl());
}

function buildMenu() {
  const c = readCfg();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'مقدار', submenu: [
    { label: 'شاشة كاملة', type: 'checkbox', checked: !!c.fullscreen, accelerator: 'F11', click: i => { writeCfg({ fullscreen: i.checked }); win && win.setFullScreen(i.checked); } },
    { label: 'تشغيل مع ويندوز', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: i => { writeCfg({ autostart: i.checked }); app.setLoginItemSettings({ openAtLogin: i.checked }); } },
    { label: 'إعادة تحميل', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
    { type: 'separator' }, { role: 'quit', label: 'خروج' } ] },
    { label: 'تحرير', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));   // Edit menu: copy/paste shortcuts need it on macOS
}

// ---- IPC (every handler re-checks the calling frame's origin) ----
ipcMain.on('miqdar:version', e => { e.returnValue = senderOk(e) ? app.getVersion() : ''; });
const sysPrinters = async () => (await (win && !win.isDestroyed() ? win.webContents : BrowserWindow.getAllWindows()[0].webContents).getPrintersAsync()).map(p => ({ name: String(p.name), isDefault: !!p.isDefault, status: Number(p.status) || 0 }));
const printer = createPrinter({ getPrinters: sysPrinters, platform: process.platform });
ipcMain.handle('miqdar:printers', async e => { if (!senderOk(e)) deny(); return (await sysPrinters()).map(p => ({ ...p, virtual: isVirtual(p.name) })); });
ipcMain.handle('miqdar:diag', async e => { if (!senderOk(e)) deny(); return { app: app.getVersion(), electron: process.versions.electron, ...(await printer.diag()) }; });

function hiddenWin() { return new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } }); }
const mmToMicrons = v => Math.round(v * 1000);
const px = mm => Math.round(mm * 96 / 25.4);   // Electron custom margins are in pixels
function pageOpts(r) {
  const o = {};
  if (r.paper === 'A4') o.pageSize = 'A4';
  else if (r.paper) o.pageSize = { width: mmToMicrons(r.paper.w_mm), height: mmToMicrons(r.paper.h_mm) };
  return o;
}
function printOpts(r, name) {
  const o = { silent: true, printBackground: true, copies: r.copies, deviceName: name, ...pageOpts(r) };
  o.margins = r.margins ? { marginType: 'custom', top: px(r.margins.top), right: px(r.margins.right), bottom: px(r.margins.bottom), left: px(r.margins.left) } : { marginType: 'none' };
  return o;
}
const wcPrint = (wc, o) => new Promise((res, rej) => wc.print(o, (ok, why) => ok ? res() : rej(new Error(why || 'print failed'))));
function printPdfFile(f, name, copies) {
  if (process.platform === 'win32') return require('pdf-to-printer').print(f, { printer: name, copies, scale: 'fit' });   // bundled SumatraPDF, silent
  return new Promise((res, rej) => execFile('lp', ['-d', name, '-n', String(copies), '-o', 'fit-to-page', f], { timeout: 30000 }, er => er ? rej(er) : res()));   // macOS / Linux (CUPS)
}
async function withPdfFile(buf, fn) { const f = path.join(os.tmpdir(), 'miqdar-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.pdf'); fs.writeFileSync(f, buf); try { return await fn(f); } finally { fs.unlink(f, () => {}); } }
// html / url / the current page → { direct, pdf } jobs for the orchestrator
const jobFor = (wc, r) => ({
  direct: name => wcPrint(wc, printOpts(r, name)),
  pdf: name => wc.printToPDF({ printBackground: true, ...pageOpts(r), margins: { marginType: 'none' } }).then(buf => withPdfFile(buf, f => printPdfFile(f, name, r.copies))),
});

ipcMain.handle('miqdar:print', async (e, raw) => {
  if (!senderOk(e)) deny();
  let r; try { r = validatePrint(raw, OPTS); } catch (err) { return { ok: false, error: err.message }; }
  if (r.source === 'pdfBase64') return printer.printJob(r, { direct: name => withPdfFile(Buffer.from(r.pdfBase64, 'base64'), f => printPdfFile(f, name, r.copies)) });
  let w;
  try {
    w = hiddenWin();
    if (r.source === 'html') await w.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(r.html, 'utf8').toString('base64'));
    else await w.loadURL(r.url);
    return await printer.printJob(r, jobFor(w.webContents, r));
  } catch (err) { return { ok: false, error: String(err && err.message || err).slice(0, 200) }; }
  finally { if (w && !w.isDestroyed()) w.destroy(); }
});
// the page's own window.print() (and Ctrl+P) is redirected here by the preload: prints the current page silently, never opens the system dialog
const printCurrentPage = async (wc, printerName) => printer.printJob({ printer: printerName || '', copies: 1, paper: null, margins: null }, jobFor(wc, { copies: 1, paper: null, margins: null }));
ipcMain.handle('miqdar:printPage', async (e, name) => { if (!senderOk(e)) deny(); return printCurrentPage(e.sender, typeof name === 'string' ? name.slice(0, 200) : ''); });

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
  // silent background update: no toast, no dialog, errors swallowed (macOS needs a signed app to self-update; until then new versions are installed manually)
  if (app.isPackaged) { try { const { autoUpdater } = require('electron-updater'); autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.on('error', () => {}); autoUpdater.checkForUpdates().catch(() => {}); } catch (_) {} }
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
