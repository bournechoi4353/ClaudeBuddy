// One-shot: render the Clawd pixel art into build/icon.png at 1024x1024 with
// a cream background. Pure JS PNG encoder — no canvas, no native deps.
// Run with: node scripts/generate-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRAB = [
  '..OOOOOOOO..',
  '..OXOOOOXO..',
  '..OOOOOOOO..',
  'OOOOOOOOOOOO',
  'OOOOOOOOOOOO',
  '..OOOOOOOO..',
  '..OOOOOOOO..',
  '..OOOOOOOO..',
  '..O.O..O.O..',
  '..O.O..O.O..',
];

const BG = [0xF5, 0xF0, 0xE6, 0xFF];          // cream
const ORANGE = [0xCC, 0x78, 0x5C, 0xFF];      // Claude orange
const BLACK = [0x00, 0x00, 0x00, 0xFF];

const W = 1024, H = 1024;
const CELL = 70;
const COLS = CRAB[0].length;
const ROWS = CRAB.length;
const OFFSET_X = Math.floor((W - COLS * CELL) / 2);
const OFFSET_Y = Math.floor((H - ROWS * CELL) / 2);

// Fill background
const px = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  px[i * 4 + 0] = BG[0];
  px[i * 4 + 1] = BG[1];
  px[i * 4 + 2] = BG[2];
  px[i * 4 + 3] = BG[3];
}

// Stamp crab cells
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const ch = CRAB[r][c];
    if (ch === '.') continue;
    const color = ch === 'X' ? BLACK : ORANGE;
    const cx = OFFSET_X + c * CELL;
    const cy = OFFSET_Y + r * CELL;
    for (let dy = 0; dy < CELL; dy++) {
      for (let dx = 0; dx < CELL; dx++) {
        const idx = ((cy + dy) * W + (cx + dx)) * 4;
        px[idx + 0] = color[0];
        px[idx + 1] = color[1];
        px[idx + 2] = color[2];
        px[idx + 3] = color[3];
      }
    }
  }
}

// --- minimal PNG encoder ---
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

// Add filter byte (0 = None) to each scanline
const scanlines = Buffer.alloc(W * H * 4 + H);
for (let y = 0; y < H; y++) {
  scanlines[y * (W * 4 + 1)] = 0;
  px.copy(scanlines, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(scanlines);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // 8-bit channels
ihdr[9] = 6;   // RGBA
ihdr[10] = 0;  // deflate
ihdr[11] = 0;  // adaptive filter
ihdr[12] = 0;  // no interlace

const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, '(' + png.length + ' bytes)');
