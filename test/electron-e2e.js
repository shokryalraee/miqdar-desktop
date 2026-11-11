// REAL Electron under xvfb with a CUPS queue as the printer: proves the silent path (no dialog) end to end.
// Setup (Linux): apt-get install -y xvfb cups cups-pdf; cupsd; lpadmin -p TestReceipt -E -v cups-pdf:/ -m lsb/usr/cups-pdf/CUPS-PDF_opt.ppd; lpadmin -d TestReceipt
// (the queue name must NOT contain «pdf» — virtual printers are refused on purpose). Run: npm install && NODE_PATH=<dir with playwright> xvfb-run -a node test/electron-e2e.js
const {chromium}=require('playwright'); const {spawn}=require('child_process'); const http=require('http'),fs=require('fs');
const ok=(c,m)=>{console.log((c?'✔ ':'✘ FAIL ')+m); if(!c) process.exitCode=1;};
(async()=>{ const srv=http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<!doctype html><meta charset=utf-8><title>t</title><h1>Miqdar print test</h1><p>فاتورة 123</p>')}).listen(8767);
 const env={...process.env,MIQDAR_DEV:'1',MIQDAR_URL:'http://localhost:8767/',DISPLAY:process.env.DISPLAY};
 const el=spawn(require('path').join(__dirname,'..','node_modules','electron','dist','electron'),['--no-sandbox','--remote-debugging-port=9333',require('path').join(__dirname,'..')],{env,stdio:['ignore','pipe','pipe']}); let out='';el.stdout.on('data',d=>out+=d);el.stderr.on('data',d=>out+=d);
 let b; for(let i=0;i<30;i++){ try{ b=await chromium.connectOverCDP('http://localhost:9333'); break;}catch(e){ await new Promise(r=>setTimeout(r,500)); } }
 const pg=b.contexts()[0].pages()[0]; await pg.waitForLoadState(); await pg.waitForTimeout(800);
 ok(await pg.evaluate(()=>!!window.MiqdarNative&&typeof MiqdarNative.printPage==='function'),'MiqdarNative exposed in the real Electron renderer (sandboxed preload works)');
 const pr=await pg.evaluate(()=>MiqdarNative.printers()); console.log('printers',JSON.stringify(pr)); ok(pr.some(p=>p.name==='TestReceipt'),'printers() lists the CUPS queue');
 const before=fs.existsSync(process.env.HOME+'/PDF')?fs.readdirSync(process.env.HOME+'/PDF').length:0;
 let r=await pg.evaluate(()=>MiqdarNative.print({type:'invoice',html:'<div style="font:20px sans-serif">فاتورة 1 — test</div>',paper:{w_mm:80,h_mm:200},copies:1})); console.log('print(html)',JSON.stringify(r)); ok(r.ok,'print(html) silent via webContents.print → ok (path '+r.path+')');
 r=await pg.evaluate(()=>MiqdarNative.print({type:'a4',html:'<h1>A4 doc</h1>',paper:'A4',printer:'TestReceipt'})); console.log('print(a4)',JSON.stringify(r)); ok(r.ok,'print(a4) ok');
 r=await pg.evaluate(()=>MiqdarNative.print({type:'label',html:'<b>lbl</b>'})); ok(!r.ok&&/NO_LABEL/.test(r.error),'label without printer refused');
 await pg.evaluate(()=>{ window.__e=null; window.addEventListener('miqdar-print-error',e=>window.__e=e.detail); window.print(); }); await pg.waitForTimeout(2500);
 ok(await pg.evaluate(()=>window.__e===null),'window.print() → silent path, no dialog, no error ('+await pg.evaluate(()=>window.__e)+')');
 const d=await pg.evaluate(()=>MiqdarNative.diag()); console.log('diag log',JSON.stringify(d.log.map(x=>[x.path,x.ok,x.error||''])));
 await new Promise(r=>setTimeout(r,2500)); const files=fs.existsSync(process.env.HOME+'/PDF')?fs.readdirSync(process.env.HOME+'/PDF'):[]; ok(files.length>before,'CUPS received the jobs ('+files.length+' pdf files)');
 const wins=b.contexts()[0].pages().length; ok(wins===1,'no extra windows/dialog pages opened ('+wins+')');
 el.kill(); srv.close(); await b.close().catch(()=>{}); process.exit(process.exitCode||0); })();
