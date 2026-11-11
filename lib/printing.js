'use strict';
// Print orchestration with injected deps (no electron import → unit-testable). Goal: NEVER a dialog, NEVER a silent drop:
// resolve a real printer → webContents.print(silent) → on failure a PDF fallback (SumatraPDF via pdf-to-printer on Windows, lp elsewhere) → else a clear error.
const VIRTUAL = /pdf|onenote|xps document|fax|print to file|send to|snagit|cutepdf|primopdf|dopdf|bullzip/i;
const isVirtual = n => VIRTUAL.test(String(n || ''));
const MSG = {
  NO_PRINTERS: 'ما في أي طابعة معرّفة على هذا الجهاز',
  NO_DEFAULT_PRINTER: 'ما في طابعة افتراضية — اختر طابعة من «تشخيص الطباعة»',
  DEFAULT_IS_VIRTUAL: 'الطابعة الافتراضية للنظام هي PDF/ملف (تطلع نافذة حفظ) — اختر طابعة حقيقية',
  PRINTER_IS_VIRTUAL: 'الطابعة المختارة PDF/ملف (تطلع نافذة حفظ) — اختر طابعة حقيقية',
};
const fail = code => { const e = new Error(code + ': ' + MSG[code]); e.code = code; return e; };

// requested = printer name from the page ('' = system default). Returns the exact system name to print on, or throws a coded error.
function resolveTarget(requested, list) {
  list = Array.isArray(list) ? list : [];
  if (!list.length) throw fail('NO_PRINTERS');
  const want = String(requested || '').trim();
  if (want) {
    const p = list.find(x => x.name === want);
    if (!p) { const e = new Error('PRINTER_NOT_FOUND: ' + want); e.code = 'PRINTER_NOT_FOUND'; throw e; }
    if (isVirtual(p.name)) throw fail('PRINTER_IS_VIRTUAL');
    return p.name;
  }
  const d = list.find(x => x.isDefault);
  if (!d) { const real = list.filter(x => !isVirtual(x.name)); if (real.length === 1) return real[0].name; throw fail('NO_DEFAULT_PRINTER'); }   // a single real printer is the obvious target even if the OS reports no default
  if (isVirtual(d.name)) throw fail('DEFAULT_IS_VIRTUAL');
  return d.name;
}

function createPrinter(deps) {
  const log = [];
  const note = o => { log.push({ at: Date.now(), ...o }); if (log.length > 30) log.shift(); };
  async function printJob(req, job) {
    // job: { direct(printerName) → Promise, pdf(printerName) → Promise (fallback) }
    const t0 = Date.now(); let printer = '';
    try { printer = resolveTarget(req.printer, await deps.getPrinters()); }
    catch (e) { note({ path: 'resolve', ok: false, printer: req.printer || '', error: e.message }); return { ok: false, error: e.message, code: e.code }; }
    try { await job.direct(printer); note({ path: 'direct', ok: true, printer, ms: Date.now() - t0 }); return { ok: true, path: 'direct', printer }; }
    catch (e1) {
      note({ path: 'direct', ok: false, printer, error: String(e1 && e1.message || e1).slice(0, 160) });
      if (!job.pdf) return { ok: false, error: String(e1 && e1.message || e1).slice(0, 200) };
      try { await job.pdf(printer); note({ path: 'pdf-fallback', ok: true, printer, ms: Date.now() - t0 }); return { ok: true, path: 'pdf-fallback', printer }; }
      catch (e2) { note({ path: 'pdf-fallback', ok: false, printer, error: String(e2 && e2.message || e2).slice(0, 160) }); return { ok: false, error: 'PRINT_FAILED: ' + String(e1 && e1.message || e1).slice(0, 80) + ' | ' + String(e2 && e2.message || e2).slice(0, 80) }; }
    }
  }
  async function diag() {
    const list = await deps.getPrinters(); const def = list.find(p => p.isDefault);
    return { platform: deps.platform, printers: list.map(p => ({ name: p.name, isDefault: !!p.isDefault, status: p.status, virtual: isVirtual(p.name) })),
      defaultPrinter: def ? def.name : '', defaultIsVirtual: !!(def && isVirtual(def.name)), noPrinters: !list.length, log: log.slice(-10) };
  }
  return { printJob, diag, log };
}
module.exports = { isVirtual, resolveTarget, createPrinter, MSG };
