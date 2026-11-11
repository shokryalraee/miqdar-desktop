'use strict';
// Pure validation for the native bridge (no electron import → unit-testable). Nothing here stores secrets.
const TYPES = ['invoice', 'a4', 'label'];
const LIMITS = { html: 5 * 1024 * 1024, pdfB64: 28 * 1024 * 1024, copies: 20, printer: 200, mmMin: 20, mmMax: 2000, marginMax: 50, netBody: 2 * 1024 * 1024 };
const NET_PATHS = ['/cgi-bin/epos/service.cgi', '/StarWebPRNT/SendMessage'];

function baseHosts(extra) { return ['miqdarerp.com'].concat(extra || []); }
// allowed = exact host or a subdomain of one of the base domains; https only (http only for localhost when dev=true)
function isAllowedUrl(u, opts) {
  opts = opts || {};
  let x; try { x = new URL(String(u)); } catch (e) { return false; }
  const h = x.hostname.toLowerCase();
  if (x.protocol === 'http:' && opts.dev && (h === 'localhost' || h === '127.0.0.1')) return true;
  if (x.protocol !== 'https:' || x.username || x.password) return false;
  return baseHosts(opts.hosts).some(d => h === d || h.endsWith('.' + d));
}
const isAllowedOrigin = (o, opts) => /^https?:\/\/[^/]+$/.test(String(o || '')) && isAllowedUrl(o, opts);

const bad = m => { const e = new Error(m); e.code = 'BAD_REQUEST'; return e; };
const num = (v, lo, hi, what) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw bad(what + ' out of range'); return n; };

function validatePrint(req, opts) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw bad('request');
  if (!TYPES.includes(req.type)) throw bad('type');
  const src = ['html', 'pdfBase64', 'url'].filter(k => req[k] != null && req[k] !== '');
  if (src.length !== 1) throw bad('exactly one of html|pdfBase64|url');
  const out = { type: req.type, source: src[0] };
  if (src[0] === 'html') { if (typeof req.html !== 'string' || req.html.length > LIMITS.html) throw bad('html size'); out.html = req.html; }
  if (src[0] === 'pdfBase64') { if (typeof req.pdfBase64 !== 'string' || req.pdfBase64.length > LIMITS.pdfB64 || !/^[A-Za-z0-9+/=\s]+$/.test(req.pdfBase64)) throw bad('pdf'); out.pdfBase64 = req.pdfBase64.replace(/\s/g, ''); }
  if (src[0] === 'url') { if (!isAllowedUrl(req.url, opts)) throw bad('url not allowed'); out.url = String(req.url); }
  const pr = req.printer == null ? '' : req.printer;
  if (typeof pr !== 'string' || pr.length > LIMITS.printer || /[\x00-\x1f]/.test(pr)) throw bad('printer');
  out.printer = pr.trim();
  // a label is never sent to the default / an unnamed printer
  if (out.type === 'label' && !out.printer) throw bad('NO_LABEL_PRINTER');
  out.copies = req.copies == null ? 1 : Math.round(num(req.copies, 1, LIMITS.copies, 'copies'));
  if (req.paper == null) out.paper = out.type === 'a4' ? 'A4' : null;
  else if (req.paper === 'A4') out.paper = 'A4';
  else if (typeof req.paper === 'object') out.paper = { w_mm: num(req.paper.w_mm, LIMITS.mmMin, LIMITS.mmMax, 'w_mm'), h_mm: num(req.paper.h_mm, LIMITS.mmMin, LIMITS.mmMax, 'h_mm') };
  else throw bad('paper');
  const m = req.margins;
  if (m == null) out.margins = null;
  else if (typeof m === 'number') { const v = num(m, 0, LIMITS.marginMax, 'margins'); out.margins = { top: v, right: v, bottom: v, left: v }; }
  else if (typeof m === 'object') out.margins = { top: num(m.top || 0, 0, LIMITS.marginMax, 'margin'), right: num(m.right || 0, 0, LIMITS.marginMax, 'margin'), bottom: num(m.bottom || 0, 0, LIMITS.marginMax, 'margin'), left: num(m.left || 0, 0, LIMITS.marginMax, 'margin') };
  else throw bad('margins');
  return out;
}

const isPrivateHost = h => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h); if (!m) return false; const a = +m[1], b = +m[2]; if ([1, 2, 3, 4].some(i => +m[i] > 255)) return false; return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); };
// LAN network printers only (Epson ePOS-Print / Star WebPRNT): private IPv4, fixed paths, bounded body — keeps the bridge from being a generic proxy
function validateNetPost(req) {
  if (!req || typeof req !== 'object') throw bad('request');
  let u; try { u = new URL(String(req.url)); } catch (e) { throw bad('url'); }
  if (!/^https?:$/.test(u.protocol) || !isPrivateHost(u.hostname)) throw bad('printer host must be a private LAN IPv4');
  if (u.port && !(Number(u.port) >= 1 && Number(u.port) <= 65535)) throw bad('port');
  if (!NET_PATHS.includes(u.pathname)) throw bad('path');
  if (typeof req.body !== 'string' || req.body.length > LIMITS.netBody) throw bad('body size');
  return { url: u.toString(), body: req.body, contentType: /^[\w/+.;= -]{1,80}$/.test(req.contentType || '') ? req.contentType : 'text/xml; charset=utf-8', soapAction: req.soapAction ? '""' : '' };
}
module.exports = { TYPES, LIMITS, NET_PATHS, isAllowedUrl, isAllowedOrigin, validatePrint, validateNetPost, isPrivateHost };
