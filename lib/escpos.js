'use strict';
// ESC/POS raster ("image mode") for thermal receipt printers — pure functions (no electron) so they are unit-testable.
// The receipt is rendered to a bitmap exactly `dots` wide (80mm Epson = 576, 58mm = 384) and sent as GS v 0 bands + feed + cut,
// RAW to the spooler: the printer driver, paper-size and margin settings are bypassed, so the output equals the on-screen preview.
const ESC = 0x1b, GS = 0x1d;
const LIM = { dotsMin: 256, dotsMax: 832, band: 128 };

// bgra: Buffer/Uint8Array of width*height*4 (Electron NativeImage.toBitmap() order). Returns {bytesPerRow, data(1bpp, MSB first, black=1)}
function toMono(bgra, width, height, threshold) {
  const th = threshold == null ? 150 : threshold, bpr = Math.ceil(width / 8), out = Buffer.alloc(bpr * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, a = bgra[i + 3];
    const lum = a < 30 ? 255 : 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2];   // transparent = paper
    if (lum < th) out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return { bytesPerRow: bpr, data: out };
}

// one receipt: init, raster bands, feed, partial cut. copies repeats the whole receipt.
function buildReceipt(mono, width, height, copies) {
  if (width < LIM.dotsMin || width > LIM.dotsMax) throw new Error('dots out of range');
  const bpr = mono.bytesPerRow, parts = [];
  for (let c = 0; c < Math.max(1, copies || 1); c++) {
    parts.push(Buffer.from([ESC, 0x40]));   // ESC @ initialise
    for (let y = 0; y < height; y += LIM.band) {
      const h = Math.min(LIM.band, height - y);
      parts.push(Buffer.from([GS, 0x76, 0x30, 0x00, bpr & 255, bpr >> 8, h & 255, h >> 8]), mono.data.subarray(y * bpr, (y + h) * bpr));   // GS v 0 m xL xH yL yH d…
    }
    parts.push(Buffer.from([ESC, 0x64, 0x04]), Buffer.from([GS, 0x56, 0x42, 0x00]));   // ESC d 4 (feed) + GS V 66 0 (feed to cut position, partial cut)
  }
  return Buffer.concat(parts);
}

// inverse (for tests / debugging): first receipt's raster → {width, height, rows:[Uint8Array bytes]} (stops at the first cut)
function decode(buf) {
  let i = 0, width = 0, rows = [];
  while (i < buf.length) {
    if (buf[i] === ESC && buf[i + 1] === 0x40) { i += 2; continue; }
    if (buf[i] === GS && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      const bpr = buf[i + 4] + (buf[i + 5] << 8), h = buf[i + 6] + (buf[i + 7] << 8); width = bpr * 8; i += 8;
      for (let r = 0; r < h; r++) { rows.push(buf.subarray(i, i + bpr)); i += bpr; } continue;
    }
    if (buf[i] === ESC && buf[i + 1] === 0x64) { i += 3; continue; }
    if (buf[i] === GS && buf[i + 1] === 0x56) break;
    throw new Error('unexpected byte at ' + i);
  }
  return { width, height: rows.length, rows };
}

// thermal ESC/POS-compatible receipt printers by name (conservative: Star StarPRNT is NOT ESC/POS; unknown names stay on the driver path)
const THERMAL_NAME = /(?<![A-Za-z0-9])(TM-?[A-Z]?\d{2,3}|T88|T20|T82|T70|m30|m10|XP-?\d{2,3}|POS-?\d{2}|RP-?\d{3}|receipt|thermal|ESC\/?POS|80\s?mm|58\s?mm)/i;
const looksThermal = n => THERMAL_NAME.test(String(n || ''));
module.exports = { LIM, toMono, buildReceipt, decode, looksThermal };
