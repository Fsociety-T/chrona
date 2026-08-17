/* Shared icon rendering — a tiny PNG encoder plus the Chrona mark.
   Pure Node (`zlib` only), so icon generation needs nothing installed.
   Used by tools/make-icons.js (PWA) and tools/android-icons.js (APK).
*/
'use strict';

const zlib = require('zlib');

/* ── minimal PNG encoder ─────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Each scanline carries a leading filter byte (0 = none).
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── the Chrona mark ─────────────────────────────────────── */

const SS = 4; // supersample factor, for smooth edges

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/* opts:
     maskable    — full-bleed plate with extra safe padding (Android adaptive)
     transparent — no plate at all (adaptive-icon foreground layer)
*/
function draw(size, opts) {
  opts = opts || {};
  const maskable = !!opts.maskable;
  const transparent = !!opts.transparent;

  const S = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const acc = new Float32Array(size * size * 4);

  const cx = S / 2, cy = S / 2;
  // Adaptive-icon foregrounds get cropped hard, so the glyph sits well inside.
  const pad = (maskable || transparent) ? S * 0.30 : S * 0.16;
  const radius = S / 2 - pad;

  const bgInset = maskable ? 0 : S * 0.045;
  const bgR = maskable ? 0 : S * 0.22;

  const C_BG_A  = [0x1a, 0x1f, 0x33];
  const C_BG_B  = [0x0b, 0x0d, 0x14];
  const C_RING  = [0x2a, 0x31, 0x4a];
  const C_ACC_A = [0x6c, 0x8c, 0xff];
  const C_ACC_B = [0xa9, 0x7b, 0xff];
  const C_HAND  = [0xee, 0xf1, 0xf8];

  const ringW = S * 0.062;
  const handW = S * 0.052;

  const arcFrom = -Math.PI / 2;
  const arcTo = arcFrom + Math.PI * 1.55;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const oi = ((y / SS | 0) * size + (x / SS | 0)) * 4;

      let r = 0, g = 0, b = 0, a = 0;

      if (!transparent) {
        let inPlate;
        if (maskable) {
          inPlate = true;
        } else {
          const lx = Math.max(bgInset + bgR - x, x - (S - bgInset - bgR), 0);
          const ly = Math.max(bgInset + bgR - y, y - (S - bgInset - bgR), 0);
          inPlate = (lx * lx + ly * ly) <= bgR * bgR &&
                    x >= bgInset && x <= S - bgInset &&
                    y >= bgInset && y <= S - bgInset;
        }
        if (inPlate) {
          const c = mix(C_BG_A, C_BG_B, (x + y) / (2 * S));
          r = c[0]; g = c[1]; b = c[2]; a = 255;
        }
      }

      // Glyph draws onto the plate, or straight onto transparency.
      if (a > 0 || transparent) {
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const onRing = Math.abs(dist - radius) < ringW / 2;

        if (onRing) {
          r = C_RING[0]; g = C_RING[1]; b = C_RING[2];
          if (transparent) a = 255;

          let norm = Math.atan2(dy, dx);
          while (norm < arcFrom) norm += Math.PI * 2;
          if (norm <= arcTo) {
            const c = mix(C_ACC_A, C_ACC_B, (norm - arcFrom) / (arcTo - arcFrom));
            r = c[0]; g = c[1]; b = c[2];
          }
        }

        const handLenV = radius * 0.56;
        const handLenH = radius * 0.40;
        const onHandV = Math.abs(dx) < handW / 2 && dy < 0 && dy > -handLenV;
        const onHandH = Math.abs(dy) < handW / 2 && dx > 0 && dx < handLenH;
        const onPin = dist < handW * 0.85;

        if (onHandV || onHandH || onPin) {
          r = C_HAND[0]; g = C_HAND[1]; b = C_HAND[2];
          if (transparent) a = 255;
        }
      }

      acc[oi]     += r;
      acc[oi + 1] += g;
      acc[oi + 2] += b;
      acc[oi + 3] += a;
    }
  }

  const n = SS * SS;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(acc[i] / n);

  return encodePng(out, size, size);
}

/* A flat colour square — used as the adaptive icon's background layer. */
function solid(size, hex) {
  const h = hex.replace('#', '');
  const R = parseInt(h.slice(0, 2), 16);
  const G = parseInt(h.slice(2, 4), 16);
  const B = parseInt(h.slice(4, 6), 16);
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = R; buf[i * 4 + 1] = G; buf[i * 4 + 2] = B; buf[i * 4 + 3] = 255;
  }
  return encodePng(buf, size, size);
}

module.exports = { encodePng, draw, solid };
