'use strict';
/**
 * scripts/make-icon.js
 * Generates build/icon-placeholder.ico (EVE-teal solid). Run manually if you need a placeholder.
 * For the EXE/installer, put your own icon as build/app.ico — the build uses that file (see package.json).
 */
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_PATH = path.join(__dirname, '..', 'build', 'icon-placeholder.ico');

// ── Skip if placeholder already exists ─────────────────────────────────────────
if (fs.existsSync(OUT_PATH)) {
  console.log('[make-icon] build/icon-placeholder.ico already exists — skipping.');
  process.exit(0);
}

// ── CRC-32 (needed for PNG chunk checksums) ───────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32be(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([u32be(data.length), t, data, u32be(crc32(Buffer.concat([t, data])))]);
}

// ── Solid-colour RGBA PNG of arbitrary size ───────────────────────────────────
function solidPNG(sz, r, g, b) {
  const rowLen = 1 + sz * 4;           // 1 filter byte + 4 bytes/pixel
  const raw    = Buffer.allocUnsafe(sz * rowLen);
  for (let y = 0; y < sz; y++) {
    raw[y * rowLen] = 0;               // filter: None
    for (let x = 0; x < sz; x++) {
      const i = y * rowLen + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(sz, 0);           // width
  ihdr.writeUInt32BE(sz, 4);           // height
  ihdr[8]  = 8;                        // bit depth
  ihdr[9]  = 6;                        // colour type: RGBA
  ihdr[10] = 0;                        // compression
  ihdr[11] = 0;                        // filter
  ihdr[12] = 0;                        // interlace

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),   // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO container (PNG-in-ICO, supported on Windows Vista+) ──────────────────
function buildICO(sizes, pngs) {
  const count = sizes.length;

  // ICO file header (6 bytes): reserved | type=1 | image count
  const hdr = Buffer.allocUnsafe(6);
  hdr.writeUInt16LE(0, 0);
  hdr.writeUInt16LE(1, 2);
  hdr.writeUInt16LE(count, 4);

  // Directory: 16 bytes per image
  const dir  = Buffer.allocUnsafe(count * 16);
  let offset = 6 + count * 16;

  for (let i = 0; i < count; i++) {
    const sz  = sizes[i];
    const len = pngs[i].length;
    const base = i * 16;
    dir[base + 0] = sz >= 256 ? 0 : sz;   // 0 means 256
    dir[base + 1] = sz >= 256 ? 0 : sz;
    dir[base + 2] = 0;                     // colour count (0 = true-colour)
    dir[base + 3] = 0;                     // reserved
    dir.writeUInt16LE(1,  base + 4);       // colour planes
    dir.writeUInt16LE(32, base + 6);       // bits per pixel
    dir.writeUInt32LE(len,    base + 8);   // bytes in resource
    dir.writeUInt32LE(offset, base + 12);  // offset from file start
    offset += len;
  }

  return Buffer.concat([hdr, dir, ...pngs]);
}

// ── Generate & write ──────────────────────────────────────────────────────────
const R = 0x0D, G = 0x7B, B = 0x8E;  // EVE teal #0D7B8E

const sizes = [16, 32, 48, 256];
const pngs  = sizes.map(sz => solidPNG(sz, R, G, B));
const ico   = buildICO(sizes, pngs);

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, ico);
console.log('[make-icon] Generated build/icon-placeholder.ico');
console.log('[make-icon] For the app/installer icon, put your .ico as build/app.ico and run npm run dist.');
