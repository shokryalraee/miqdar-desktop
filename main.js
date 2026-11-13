'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, clipboard, dialog, session } = require('electron');
const { execFile } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), https = require('https');
const { createPrinter, isVirtual } = require('./lib/printing');
const escpos = require('./lib/escpos');
const { createUpdater } = require('./lib/updater');
const { createAgent } = require('./lib/agent-core');
const { isAllowedUrl, isAllowedOrigin, validatePrint, validateNetPost } = require('./lib/guard');

const DEV = process.env.MIQDAR_DEV === '1';
const EXTRA = (process.env.MIQDAR_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const OPTS = { dev: DEV, hosts: EXTRA };
const cfgFile = () => path.join(app.getPath('userData'), 'miqdar-config.json');   // non-secret prefs only
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch (e) { return {}; } };
const writeCfg = o => { try { fs.writeFileSync(cfgFile(), JSON.stringify({ ...readCfg(), ...o }, null, 1)); } catch (e) {} };
const startUrl = () => { const u = process.env.MIQDAR_URL || readCfg().url || 'https://app.miqdarerp.com'; return isAllowedUrl(u, OPTS) ? u : 'https://app.miqdarerp.com'; };

let win, updater = null;
if (process.platform === 'win32') app.setAppUserModelId('com.miqdarerp.cashier');   // proper Windows identity (taskbar / notifications)
const ICON = path.join(__dirname, 'build', 'icon.png');
if (!app.requestSingleInstanceLock()) app.quit();
// a second launch (or the tray/start menu) while the app runs in the background: show the window — never touch a destroyed one ("Object has been destroyed")
app.on('second-instance', () => { try { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else if (app.isReady()) createWindow(); } catch (e) { win = null; try { createWindow(); } catch (_) {} } });

const senderOk = e => { try { return isAllowedOrigin(new URL(e.senderFrame.url).origin, OPTS) && e.senderFrame === e.sender.mainFrame; } catch (_) { return false; } };
const deny = () => { const e = new Error('origin not allowed'); e.code = 'ORIGIN'; throw e; };

function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 800, show: false, autoHideMenuBar: true, icon: ICON, fullscreen: !!readCfg().fullscreen,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.webContents.on('before-input-event', (ev, input) => { if ((input.control || input.meta) && !input.alt && String(input.key).toLowerCase() === 'p' && input.type === 'keyDown') { ev.preventDefault(); printCurrentPage(win.webContents, {}).then(r => { if (!r.ok && win && !win.isDestroyed()) win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("miqdar-print-error",{detail:' + JSON.stringify(String(r.error || '')) + '}))').catch(() => {}); }); } });   // Ctrl/Cmd+P → silent path, no dialog
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  win.on('closed', () => { win = null; });
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
    { label: 'شاشة كاملة', type: 'checkbox', checked: !!c.fullscreen, accelerator: 'F11', click: i => { writeCfg({ fullscreen: i.checked }); win && !win.isDestroyed() && win.setFullScreen(i.checked); } },
    { label: 'تشغيل مع ويندوز (وكيل الطباعة بالخلفية)', type: 'checkbox', checked: !!c.autostart, click: i => { writeCfg({ autostart: i.checked }); app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--agent'] }); } },
    { label: 'إعادة تحميل', accelerator: 'CmdOrCtrl+R', click: () => win && !win.isDestroyed() && win.reload() },
    { type: 'separator' }, { role: 'quit', label: 'خروج' } ] },
    { label: 'تحرير', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));   // Edit menu: copy/paste shortcuts need it on macOS
}

// ---- IPC (every handler re-checks the calling frame's origin) ----
ipcMain.handle('miqdar:update', e => { if (!senderOk(e)) deny(); return updater ? updater.state() : { status: 'off', version: null, error: '' }; });
ipcMain.handle('miqdar:restart', e => { if (!senderOk(e)) deny(); return updater ? updater.restart() : false; });
ipcMain.on('miqdar:version', e => { e.returnValue = senderOk(e) ? app.getVersion() : ''; });
let hostWin = null;
const anyWc = () => { if (win && !win.isDestroyed()) return win.webContents; if (!hostWin || hostWin.isDestroyed()) hostWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); return hostWin.webContents; };   // background (tray-only) mode has no main window
const sysPrinters = async () => (await anyWc().getPrintersAsync()).map(p => ({ name: String(p.name), isDefault: !!p.isDefault, status: Number(p.status) || 0 }));
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
  o.margins = r.pageMode && !r.margins ? { marginType: 'default' } : r.margins ? { marginType: 'custom', top: px(r.margins.top), right: px(r.margins.right), bottom: px(r.margins.bottom), left: px(r.margins.left) } : { marginType: 'none' };
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
  direct: name => (DEV && process.env.MIQDAR_FORCE_PDF === '1') ? Promise.reject(new Error('forced (test)')) : wcPrint(wc, printOpts(r, name)),   // MIQDAR_FORCE_PDF: tests the PDF fallback path
  pdf: name => wc.printToPDF({ printBackground: true, ...(r.pageMode ? { preferCSSPageSize: !r.paper } : { margins: { marginType: 'none' } }), ...pageOpts(r) }).then(buf => withPdfFile(buf, f => printPdfFile(f, name, r.copies))),
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

// ---- ESC/POS "image mode" for thermal receipt printers: render the receipt to a bitmap exactly `dots` wide and send it RAW (bypasses driver, paper size, margins) ----
const BUILD_DOC = "(function(){var css='';for(var i=0;i<document.styleSheets.length;i++){try{var rs=document.styleSheets[i].cssRules;for(var j=0;j<rs.length;j++)css+=rs[j].cssText+'\\n';}catch(e){}}var pa=document.getElementById('printArea');return '<!doctype html><html dir=\"'+(document.documentElement.dir||'rtl')+'\" lang=\"'+(document.documentElement.lang||'ar')+'\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"script-src \\'none\\'\"><style>'+css+'</style></head><body><div id=\"printArea\" style=\"display:block!important\">'+(pa?pa.innerHTML:'')+'</div></body></html>';})()";
const WAIT_ASSETS = "Promise.race([Promise.all([document.fonts?document.fonts.ready:0].concat([].map.call(document.images,function(i){return i.complete?0:new Promise(function(x){i.onload=i.onerror=x})}))),new Promise(function(x){setTimeout(x,5000)})])";
async function renderReceiptBitmap(wc, dots) {
  const doc = await wc.executeJavaScript(BUILD_DOC);
  const origin = new URL(wc.getURL()).origin; if (!isAllowedOrigin(origin, OPTS)) throw new Error('origin');
  return renderDocBitmap(doc, origin, dots);
}
// doc = a full HTML document string; origin = allowed origin to load fonts/images from (or null → about:blank, the doc must then be self-contained)
async function renderDocBitmap(doc, origin, dots) {
  const vw = Math.round(dots * 0.495), zoom = dots / vw;   // layout at the receipt's CSS width (≈76mm for 80mm paper), rendered at `dots` device pixels
  const w = new BrowserWindow({ show: false, width: dots, height: 1000, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await w.loadURL(origin ? origin + '/manifest.webmanifest' : 'about:blank');   // same origin → fonts/images load; the page is then replaced by the receipt document (scripts blocked by CSP)
    const c = w.webContents; c.setZoomFactor(zoom);
    await c.executeJavaScript('document.open();document.write(' + JSON.stringify(doc) + ');document.close();');
    await c.executeJavaScript(WAIT_ASSETS);
    try { c.debugger.attach('1.3'); await c.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' }); } catch (_) {}
    await c.insertCSS('html,body{margin:0!important;background:#fff!important}#printArea,#printArea .rc{width:100%!important;max-width:none!important;margin:0!important;box-sizing:border-box!important;box-shadow:none!important;border-radius:0!important}');
    w.setContentSize(dots, 1000); await new Promise(r => setTimeout(r, 150));
    const h = Math.min(8000, Math.max(40, Math.ceil(await c.executeJavaScript('(function(){var b=document.body.getBoundingClientRect();return Math.max(1,Math.ceil(b.bottom+(window.scrollY||0)))})()') * zoom)));
    w.setContentSize(dots, h); await new Promise(r => setTimeout(r, 250));
    let img = await c.capturePage({ x: 0, y: 0, width: dots, height: h });
    if (img.getSize().width !== dots) img = img.resize({ width: dots, quality: 'best' });   // Windows display scaling returns more pixels
    const s = img.getSize(); return { bgra: img.toBitmap(), width: s.width, height: s.height };
  } finally { if (!w.isDestroyed()) w.destroy(); }
}
const PS_RAW = `param([string]$Printer,[string]$File)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class MiqdarRaw {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
 [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool OpenPrinter(string n,out IntPtr h,IntPtr d);
 [DllImport("winspool.drv",SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
 [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool StartDocPrinter(IntPtr h,int level,[In] DOCINFO di);
 [DllImport("winspool.drv",SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
 [DllImport("winspool.drv",SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
 [DllImport("winspool.drv",SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
 [DllImport("winspool.drv",SetLastError=true)] public static extern bool WritePrinter(IntPtr h,byte[] b,int c,out int w);
 public static void Send(string printer,byte[] data){ IntPtr h; if(!OpenPrinter(printer,out h,IntPtr.Zero)) throw new Exception("OpenPrinter "+Marshal.GetLastWin32Error());
  DOCINFO di=new DOCINFO(); di.pDocName="Miqdar receipt"; di.pDataType="RAW";
  if(!StartDocPrinter(h,1,di)){ ClosePrinter(h); throw new Exception("StartDocPrinter "+Marshal.GetLastWin32Error()); }
  StartPagePrinter(h); int w; bool ok=WritePrinter(h,data,data.Length,out w); EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
  if(!ok||w!=data.Length) throw new Exception("WritePrinter "+Marshal.GetLastWin32Error()); } }
"@
[MiqdarRaw]::Send($Printer,[IO.File]::ReadAllBytes($File))
`;
async function sendRaw(name, buf) {
  if (DEV && process.env.MIQDAR_RAW_DUMP) { fs.writeFileSync(path.join(process.env.MIQDAR_RAW_DUMP, 'raw-' + Date.now() + '.bin'), buf); return; }   // tests: capture the bytes instead of spooling
  const tmp = path.join(os.tmpdir(), 'miqdar-raw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  fs.writeFileSync(tmp + '.bin', buf);
  try {
    if (process.platform === 'win32') {
      fs.writeFileSync(tmp + '.ps1', PS_RAW, 'utf8');
      await new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp + '.ps1', '-Printer', name, '-File', tmp + '.bin'], { timeout: 30000, windowsHide: true }, (er, so, se) => er ? rej(new Error('RAW: ' + String(se || er.message).slice(0, 160))) : res()));
    } else await new Promise((res, rej) => execFile('lp', ['-d', name, '-o', 'raw', tmp + '.bin'], { timeout: 30000 }, er => er ? rej(er) : res()));
  } finally { fs.unlink(tmp + '.bin', () => {}); fs.unlink(tmp + '.ps1', () => {}); }
}
const rasterJob = (wc, r) => ({ directName: 'raster', fallbackName: 'driver',
  direct: async name => { const bm = await renderReceiptBitmap(wc, r.raster.dots); await sendRaw(name, escpos.buildReceipt(escpos.toMono(bm.bgra, bm.width, bm.height), bm.width, bm.height, r.copies)); },
  pdf: name => wcPrint(wc, printOpts(r, name)),   // if RAW fails: back to the normal driver path (then its own PDF fallback is not tried — the driver result is reported)
});

// Print the CURRENT page (the web app's #printArea with ALL its CSS, fonts, images, SVG/QR) silently. Used for window.print()/Ctrl+P and by the adapter
// (native-print.js puts the document into #printArea first), so paper output == the on-screen preview. printToPDF fallback uses the same page.
const printCurrentPage = async (wc, opts) => {
  let r; try { r = validatePrint({ type: 'invoice', ...(opts || {}), html: 'x' }, OPTS); } catch (err) { return { ok: false, error: err.message }; }
  r.pageMode = true;
  // fonts/images in #printArea are only requested once it is laid out (it is display:none on screen) → force a hidden layout pass and wait, else the print uses fallback fonts
  try { await wc.executeJavaScript("(async function(){var pa=document.getElementById('printArea'),old=pa?pa.getAttribute('style'):null;if(pa)pa.style.cssText='display:block!important;position:fixed;left:-99999px;top:0;visibility:hidden';await new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(r)})});await Promise.race([Promise.all([document.fonts?document.fonts.ready:0].concat([].map.call(document.images,function(i){return i.complete?0:new Promise(function(x){i.onload=i.onerror=x})}))),new Promise(function(x){setTimeout(x,4000)})]);if(pa){if(old===null)pa.removeAttribute('style');else pa.setAttribute('style',old)}})()"); } catch (_) {}
  let css; try { css = await wc.insertCSS('@media print{html,body,#printArea{background:#fff!important}}'); } catch (_) {}   // no grey app background on paper
  try { return await printer.printJob(r, r.raster ? rasterJob(wc, r) : jobFor(wc, r)); } finally { if (css) wc.removeInsertedCSS(css).catch(() => {}); }
};
ipcMain.handle('miqdar:printPage', async (e, opts) => { if (!senderOk(e)) deny(); return printCurrentPage(e.sender, typeof opts === 'string' ? { printer: opts.slice(0, 200) } : (opts && typeof opts === 'object' ? opts : {})); });

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


// ================= Miqdar Print Agent (local API on 127.0.0.1, see docs/PRINT-AGENT.md) =================
// Lets the WEB app pick ANY installed printer by name: GET /printers, POST /print {html|pdf|escpos-raw}. Runs inside the desktop app; with `--agent` it is tray-only (no window).
const BACKGROUND = process.argv.includes('--agent');
let agent = null, tray = null, pairCode = '';
async function withDocWindow(html, base, fn) {
  const w = new BrowserWindow({ show: false, width: 800, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await w.loadURL(base ? base + '/manifest.webmanifest' : 'about:blank');
    const doc = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">' + html;   // the page's scripts never run; only our own executeJavaScript
    await w.webContents.executeJavaScript('document.open();document.write(' + JSON.stringify(doc) + ');document.close();');
    await w.webContents.executeJavaScript(WAIT_ASSETS);
    return await fn(w.webContents);
  } finally { if (!w.isDestroyed()) w.destroy(); }
}
async function agentExecute(spec) {
  const r = { ...spec, copies: spec.copies || 1 };
  let res;
  if (spec.kind === 'raw') res = await printer.printJob(r, { directName: 'raw', direct: name => sendRaw(name, Buffer.concat(Array.from({ length: r.copies }, () => spec.bytes))) });
  else if (spec.kind === 'pdf') res = await printer.printJob(r, { direct: name => withPdfFile(Buffer.from(spec.pdfBase64, 'base64'), f => printPdfFile(f, name, r.copies)) });
  else if (spec.raster) res = await printer.printJob(r, { directName: 'raster', fallbackName: 'driver',
    direct: async name => { const bm = await renderDocBitmap(spec.html, spec.baseUrl, spec.raster.dots); await sendRaw(name, escpos.buildReceipt(escpos.toMono(bm.bgra, bm.width, bm.height), bm.width, bm.height, r.copies)); },
    pdf: name => withDocWindow(spec.html, spec.baseUrl, wc => wcPrint(wc, printOpts({ ...r, pageMode: !r.paper }, name))) });
  else {   // html → silent driver print of the document (no dialog); PDF fallback on failure
    r.pageMode = !r.paper && !r.margins;
    res = await printer.printJob(r, { direct: name => withDocWindow(spec.html, spec.baseUrl, wc => wcPrint(wc, printOpts(r, name))),
      pdf: name => withDocWindow(spec.html, spec.baseUrl, wc => wc.printToPDF({ printBackground: true, ...(r.pageMode ? { preferCSSPageSize: true } : { margins: { marginType: 'none' } }), ...pageOpts(r) }).then(buf => withPdfFile(buf, f => printPdfFile(f, name, r.copies)))) });
  }
  if (!res.ok) { const e = new Error(res.error || 'print failed'); e.code = res.code; throw e; }
  return res;
}
function trayMenu() {
  const c = readCfg(), port = agent ? agent.port() : 0;
  return Menu.buildFromTemplate([
    { label: 'مقدار — وكيل الطباعة' + (port ? ' (المنفذ ' + port + ')' : ' (متوقف)'), enabled: false },
    { label: 'رمز الاقتران: ' + (agent ? agent.code() : '—'), enabled: false },
    { label: 'نسخ رمز الاقتران', click: () => { try { clipboard.writeText(agent.code()); } catch (_) {} } },
    { label: 'إلغاء كل الاقتران', click: () => agent && agent.revokeAll() },
    { type: 'separator' },
    { label: 'فتح مقدار', click: () => { if (win && !win.isDestroyed()) win.show(); else createWindow(); } },
    { label: 'تشغيل مع ويندوز (وكيل بالخلفية)', type: 'checkbox', checked: !!c.autostart, click: i => { writeCfg({ autostart: i.checked }); app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--agent'] }); } },
    { type: 'separator' }, { role: 'quit', label: 'خروج' } ]);
}
// first run: ONE simple question — keep Miqdar as a background print agent (tray icon) starting with the computer? (default = yes). One install = app + print agent + auto-update.
async function firstRunAsk() {
  const c = readCfg(); if (c.firstRunDone || BACKGROUND || (DEV && !process.env.MIQDAR_ASK_FIRSTRUN)) return;
  try {
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: 'question', buttons: ['نعم، شغّل مع ويندوز', 'لاحقاً'], defaultId: 0, cancelId: 1, title: 'مقدار',
      message: 'تشغيل مقدار مع ويندوز كوكيل طباعة بالخلفية؟', detail: 'يبقى بجانب الساعة ويطبع مباشرة على أي طابعة بدون نوافذ، ويتحدث وحده. تقدر تغيّر هذا من أيقونة مقدار.' });
    const yes = r.response === 0; writeCfg({ firstRunDone: true, autostart: yes }); app.setLoginItemSettings({ openAtLogin: yes, args: ['--agent'] });
  } catch (_) { writeCfg({ firstRunDone: true }); }
}
async function startAgent() {
  try {
    agent = createAgent({ version: app.getVersion(), platform: process.platform, originOpts: { dev: DEV, hosts: [...EXTRA, ...(readCfg().hosts || [])] },
      store: { get: readCfg, set: writeCfg },
      getPrinters: async () => (await printer.diag()).printers.map(p => ({ ...p, thermal: escpos.looksThermal(p.name) })),
      execute: agentExecute, onCode: c => { pairCode = c; if (DEV && process.env.MIQDAR_AGENT_CODE_FILE) try { fs.writeFileSync(process.env.MIQDAR_AGENT_CODE_FILE, c); } catch (_) {} } });
    await agent.start(DEV && process.env.MIQDAR_AGENT_PORT ? Number(process.env.MIQDAR_AGENT_PORT) : undefined);
  } catch (e) { agent = null; }
  try { const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }); tray = new Tray(img); tray.setToolTip('مقدار — وكيل الطباعة'); tray.setContextMenu(trayMenu()); tray.on('right-click', () => tray.setContextMenu(trayMenu())); tray.on('click', () => tray.setContextMenu(trayMenu())); } catch (_) { tray = null; }
}
ipcMain.handle('miqdar:agent', e => { if (!senderOk(e)) deny(); return { running: !!agent, port: agent ? agent.port() : 0 }; });

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));   // no camera/mic/geo etc.
  if (readCfg().autostart != null) app.setLoginItemSettings({ openAtLogin: !!readCfg().autostart, args: ['--agent'] });   // autostart = background agent (tray), no window
  buildMenu(); await startAgent(); if (!BACKGROUND) { createWindow(); win.once('ready-to-show', () => setTimeout(firstRunAsk, 1500)); }
  // silent background updates (Windows/NSIS unsigned OK; macOS needs a signed+notarized app). Check at start and every 4h; install when the app quits or on «restart now».
  // The WEB UI is not part of the app (loaded live from the server) — only this thin shell updates.
  if (app.isPackaged || (DEV && process.env.MIQDAR_UPDATE_URL)) {
    try {
      const { autoUpdater } = require('electron-updater');
      if (DEV && process.env.MIQDAR_UPDATE_URL) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: 'generic', url: process.env.MIQDAR_UPDATE_URL }); }   // tests: local generic provider
      updater = createUpdater({ autoUpdater, intervalMs: DEV && Number(process.env.MIQDAR_UPDATE_INTERVAL_MS) || undefined,
        onChange: st => { try { win && !win.isDestroyed() && win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("miqdar-update",{detail:' + JSON.stringify(st) + '}))').catch(() => {}); } catch (_) {} } }).start();
    } catch (_) {}
  }
});
app.on('window-all-closed', () => { if (!(tray && (BACKGROUND || readCfg().autostart))) app.quit(); });   // background agent (--agent, or «start with Windows» chosen) keeps running in the tray
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
