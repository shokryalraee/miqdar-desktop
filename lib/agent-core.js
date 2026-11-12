'use strict';
// Miqdar Print Agent — local HTTP API on 127.0.0.1 (no electron import → unit-testable with fake deps).
// Security: loopback only · Host must be 127.0.0.1/localhost (DNS-rebinding) · Origin must be allowed (miqdarerp.com family + registered hosts) ·
// every call except /status and /pair needs a pairing token (issued by a short-lived code shown ONLY in the tray menu) · bounded bodies · brute-force lockout.
const http = require('http'), crypto = require('crypto');
const { isAllowedOrigin, validatePrint } = require('./guard');
const PORTS = [17653, 17654, 17655, 17656, 17657, 17658];
const LIM = { body: 40 * 1024 * 1024, raw: 8 * 1024 * 1024, tokens: 10, jobs: 50, codeTtl: 10 * 60e3, failMax: 5, failWindow: 60e3, lockMs: 60e3, waitMs: 25e3 };
const DOCTYPE = { invoice: 'invoice', receipt: 'invoice', a4: 'a4', label: 'label' };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const bad = (m, code) => { const e = new Error(m); e.code = code || 'BAD_REQUEST'; return e; };
const TRANSIENT = /timeout|ECONN|EBUSY|spool|print failed|RAW:|forced/i;   // retried; validation / not-found / virtual-printer errors are not

function createAgent(deps) {
  // deps: { version, getPrinters(), execute(job)→Promise<{path,printer}>, store:{get(),set(o)}, originOpts, onCode?(code), now?() }
  const now = deps.now || Date.now, store = deps.store, jobs = new Map(), order = [];
  let server = null, port = 0, code = null, codeAt = 0, fails = [], lockUntil = 0, busy = false; const queue = [];
  const newCode = () => { code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); codeAt = now(); if (deps.onCode) deps.onCode(code); return code; };
  const tokens = () => (store.get().agentTokens || []);

  function cors(req, res, origin) {
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true'); res.setHeader('Access-Control-Max-Age', '600');   // Chrome Local Network Access / PNA preflight
  }
  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' }); res.end(b); };
  const readBody = req => new Promise((ok, no) => { let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n > LIM.body) { no(bad('body too large', 'TOO_LARGE')); req.destroy(); } else ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', no); });
  const authOf = (req, origin) => { const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(req.headers.authorization || ''); if (!m) return null; const h = sha(m[1]); return tokens().find(t => t.h === h && t.origin === origin) || null; };

  // ---- job queue (sequential; transient failures retried 2× with backoff) ----
  function enqueue(job) { jobs.set(job.id, job); order.push(job.id); while (order.length > LIM.jobs) jobs.delete(order.shift()); queue.push(job); pump(); return job; }
  async function pump() {
    if (busy) return; const job = queue.shift(); if (!job) return; busy = true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      job.status = 'printing'; job.attempts = attempt;
      try { const r = await deps.execute(job.spec); Object.assign(job, { status: 'done', ok: true, error: '', printer: r && r.printer || '', path: r && r.path || '', finishedAt: now() }); break; }
      catch (e) { job.error = String(e && e.message || e).slice(0, 200); job.ok = false; if (attempt < 3 && TRANSIENT.test(job.error)) { await new Promise(r => setTimeout(r, (deps.retryMs || 1000) * attempt)); continue; } job.status = 'error'; job.finishedAt = now(); break; }
    }
    if (job.waiters) job.waiters.forEach(f => f()); busy = false; pump();
  }
  const view = j => ({ id: j.id, status: j.status, ok: !!j.ok, error: j.error || '', attempts: j.attempts, printer: j.printer || '', path: j.path || '' });

  function toSpec(b) {
    if (!b || typeof b !== 'object') throw bad('body');
    const doc = DOCTYPE[b.docType || 'invoice']; if (!doc) throw bad('docType');
    const common = { printer: b.printer, copies: b.copies, margins: b.margins };
    const paper = b.pageSize === 'A4' ? 'A4' : (b.width_mm ? { w_mm: b.width_mm, h_mm: b.height_mm } : undefined);
    if (b.type === 'escpos-raw') {
      const buf = Buffer.from(String(b.data || ''), 'base64'); if (!buf.length || buf.length > LIM.raw) throw bad('raw size');
      const pr = String(b.printer || '').trim(); if (!pr || pr.length > 200 || /[\x00-\x1f]/.test(pr)) throw bad('printer required');   // raw bytes always go to a NAMED printer
      return { kind: 'raw', docType: doc, printer: pr, bytes: buf, copies: Math.max(1, Math.min(20, Math.round(+b.copies) || 1)) };
    }
    if (b.type === 'html') {
      const o = validatePrint({ type: doc, html: b.data, ...common, paper, raster: b.mode === 'raster' ? { dots: b.dots || 576 } : undefined }, deps.originOpts);
      let baseUrl = null; if (b.baseUrl) { try { const u = new URL(b.baseUrl); if (!isAllowedOrigin(u.origin, deps.originOpts)) throw 0; baseUrl = u.origin; } catch (_) { throw bad('baseUrl not allowed'); } }
      return { kind: 'html', docType: doc, ...o, baseUrl };
    }
    if (b.type === 'pdf') { const o = validatePrint({ type: doc, pdfBase64: b.data, ...common, paper }, deps.originOpts); return { kind: 'pdf', docType: doc, ...o }; }
    throw bad('type must be html | pdf | escpos-raw');
  }

  async function handle(req, res) {
    const host = String(req.headers.host || '').toLowerCase(); const origin = String(req.headers.origin || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 421, { ok: false, error: 'bad host' });
    if (!isAllowedOrigin(origin, deps.originOpts)) return send(res, 403, { ok: false, error: 'origin not allowed' });
    cors(req, res, origin);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1'), p = url.pathname;
    try {
      if (p === '/status' && req.method === 'GET') { const t = authOf(req, origin); return send(res, 200, { ok: true, agent: 'miqdar-print-agent', version: deps.version, api: 1, platform: deps.platform || process.platform, port, paired: !!t }); }
      if (p === '/pair' && req.method === 'POST') {
        const t0 = now(); fails = fails.filter(x => t0 - x < LIM.failWindow); if (t0 < lockUntil) return send(res, 429, { ok: false, error: 'too many attempts' });
        const b = JSON.parse((await readBody(req)) || '{}'); const live = code && t0 - codeAt < LIM.codeTtl;
        if (!live || String(b.code || '') !== code) { fails.push(t0); if (fails.length >= LIM.failMax) { lockUntil = t0 + LIM.lockMs; fails = []; } return send(res, 401, { ok: false, error: 'wrong or expired code' }); }
        const raw = crypto.randomBytes(32).toString('base64url'); const arr = tokens().filter(t => t.origin !== origin || true); arr.push({ h: sha(raw), origin, at: t0, name: String(b.name || '').slice(0, 40) });
        store.set({ agentTokens: arr.slice(-LIM.tokens) }); newCode(); return send(res, 200, { ok: true, token: raw });
      }
      const tok = authOf(req, origin); if (!tok) return send(res, 401, { ok: false, error: 'not paired' });
      if (p === '/printers' && req.method === 'GET') return send(res, 200, { ok: true, printers: await deps.getPrinters() });
      if (p === '/print' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req)); let spec; try { spec = toSpec(b); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
        const job = enqueue({ id: crypto.randomBytes(8).toString('hex'), spec, status: 'queued', attempts: 0, createdAt: now(), waiters: [] });
        if (b.wait !== false && job.status !== 'done') await new Promise(r => { job.waiters.push(r); setTimeout(r, deps.waitMs || LIM.waitMs); });
        return send(res, job.status === 'error' ? 502 : 200, { ok: job.status !== 'error', ...view(job) });
      }
      let m = /^\/jobs\/([a-f0-9]{16})$/.exec(p); if (m && req.method === 'GET') { const j = jobs.get(m[1]); return j ? send(res, 200, { ok: true, ...view(j) }) : send(res, 404, { ok: false, error: 'unknown job' }); }
      if (p === '/jobs' && req.method === 'GET') return send(res, 200, { ok: true, jobs: order.slice(-20).map(id => view(jobs.get(id))).filter(Boolean) });
      return send(res, 404, { ok: false, error: 'not found' });
    } catch (e) { return send(res, e.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: String(e.message || e).slice(0, 120) }); }
  }

  return {
    newCode, code: () => (code && now() - codeAt < LIM.codeTtl ? code : newCode()),
    revokeAll: () => store.set({ agentTokens: [] }),
    start(preferred) {
      return new Promise((ok, no) => { const list = preferred ? [preferred] : PORTS; let i = 0;
        const tryNext = () => { if (i >= list.length) return no(new Error('no free port')); const s = http.createServer((q, r) => { handle(q, r).catch(() => { try { r.writeHead(500); r.end(); } catch (_) {} }); });
          s.once('error', () => { i++; tryNext(); }); s.listen(list[i], '127.0.0.1', () => { server = s; port = s.address().port; newCode(); ok(port); }); };
        tryNext(); });
    },
    stop() { if (server) { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } }, port: () => port,
  };
}
module.exports = { createAgent, PORTS, LIM };
