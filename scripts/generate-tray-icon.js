// Generates renderer/tray-icon.png and tray-icon@2x.png: Drizzle, the raincloud, as a tiny black
// silhouette suitable for the macOS menubar. We mark it as a template image at runtime so macOS
// auto-inverts for dark mode. Run with: node scripts/generate-tray-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// The idle frame of the sprite sheet (renderer/raincloud), 15 x 10 pixels, written as text.
// Any letter is part of the silhouette. The eyes are cutouts (transparent) so the menubar
// background shows through, giving the silhouette real character.
const DRIZZLE = [
  '........OO.....',
  '......OOBBOO...',
  '..OOOOBBBBBBO..',
  '.OBBBBBBBBBBBO.',
  '.OBBSSBBSSBBBO.',
  'OBBBOOBBOOBBBBO',
  '.OBBBBBBBBBBBBO',
  '.OEEEEOOEEEEEEO',
  '..OOOOOOOOEEEO.',
  '..........OOO..',
];
const EYES = [[4, 5], [5, 5], [8, 5], [9, 5]]; // [column, row] in DRIZZLE

const W = 22, H = 16;           // the same canvas size the crab silhouette used
const X0 = 4;
const Y0 = Math.floor((H - DRIZZLE.length) / 2);
const BLACK = [0x00, 0x00, 0x00, 0xff];
const TRANSPARENT = [0x00, 0x00, 0x00, 0x00];

const px = Buffer.alloc(W * H * 4);
for (let r = 0; r < DRIZZLE.length; r++) {
  for (let c = 0; c < DRIZZLE[r].length; c++) {
    if (DRIZZLE[r][c] === '.') continue;
    if (EYES.some(([ec, er]) => ec === c && er === r)) continue;
    const idx = ((Y0 + r) * W + X0 + c) * 4;
    px[idx] = BLACK[0];
    px[idx + 1] = BLACK[1];
    px[idx + 2] = BLACK[2];
    px[idx + 3] = BLACK[3];
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function encodePng(pixels, w, h) {
  const scanlines = Buffer.alloc(w * h * 4 + h);
  for (let y = 0; y < h; y++) {
    scanlines[y * (w * 4 + 1)] = 0;
    pixels.copy(scanlines, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = process.env.ICON_OUT_DIR || path.join(__dirname, '..', 'renderer');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(px, W, H);
fs.writeFileSync(path.join(outDir, 'tray-icon.png'), png);
console.log('wrote', path.join(outDir, 'tray-icon.png'), png.length, 'bytes');

// Also write a 2x version for retina menubars (44x32), by nearest-neighbor
// upscaling the same grid 2x.
const W2 = W * 2, H2 = H * 2;
const px2 = Buffer.alloc(W2 * H2 * 4);
for (let y = 0; y < H2; y++) {
  for (let x = 0; x < W2; x++) {
    const src = (Math.floor(y / 2) * W + Math.floor(x / 2)) * 4;
    const dst = (y * W2 + x) * 4;
    px2[dst] = px[src];
    px2[dst + 1] = px[src + 1];
    px2[dst + 2] = px[src + 2];
    px2[dst + 3] = px[src + 3];
  }
}
const png2 = encodePng(px2, W2, H2);
fs.writeFileSync(path.join(outDir, 'tray-icon@2x.png'), png2);
console.log('wrote', path.join(outDir, 'tray-icon@2x.png'), png2.length, 'bytes');
