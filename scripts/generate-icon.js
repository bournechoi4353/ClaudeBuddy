// One-shot: render Drizzle, the raincloud, into build/icon.png (1024x1024) and build/icon.ico
// (16 to 256 px). The cloud is the idle frame of the sprite sheet (renderer/raincloud) written out
// as text, on a rounded plate with the transparent margin macOS app icons use.
// Pure JS PNG encoder, no canvas, no native deps. Run with: node scripts/generate-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// The idle frame of raincloud_v2.png, cropped to its 15 x 10 pixels. O is the outline, B the body,
// S the eye shading and E the underside.
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
const PALETTE = { O: '#17323a', B: '#e1e9ef', S: '#c6d2dc', E: '#b4c2cf' };
const PLATE = '#5b88a8'; // slate blue from the sprite's own palette; the pale cloud stands out on it even at 16 px

const OUT_DIR = process.env.ICON_OUT_DIR || path.join(__dirname, '..', 'build');
const W = 1024;
const H = 1024;
const PLATE_INSET = 100;  // macOS icon grid: an 824 px plate inside 1024
const PLATE_RADIUS = 185;
const CELL = 40;          // one sprite pixel is 40 icon pixels

const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

// ---- draw ----

const px = Buffer.alloc(W * H * 4); // transparent

// The plate: a rounded square with an anti-aliased edge.
const plate = rgb(PLATE);
const half = (W - 2 * PLATE_INSET) / 2;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = Math.abs(x + 0.5 - W / 2) - (half - PLATE_RADIUS);
    const dy = Math.abs(y + 0.5 - H / 2) - (half - PLATE_RADIUS);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - PLATE_RADIUS;
    const coverage = Math.min(1, Math.max(0, 0.5 - outside));
    if (coverage <= 0) continue;
    const i = (y * W + x) * 4;
    px[i] = plate[0]; px[i + 1] = plate[1]; px[i + 2] = plate[2]; px[i + 3] = Math.round(coverage * 255);
  }
}

// The cloud, centered on the plate.
const rows = DRIZZLE.length;
const cols = DRIZZLE[0].length;
const x0 = Math.floor((W - cols * CELL) / 2);
const y0 = Math.floor((H - rows * CELL) / 2);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const ch = DRIZZLE[r][c];
    if (ch === '.') continue;
    const color = rgb(PALETTE[ch]);
    for (let dy = 0; dy < CELL; dy++) {
      for (let dx = 0; dx < CELL; dx++) {
        const i = ((y0 + r * CELL + dy) * W + (x0 + c * CELL + dx)) * 4;
        px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
      }
    }
  }
}

// ---- minimal PNG encoder ----

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

function encodePng(pixels, w, h) {
  const scanlines = Buffer.alloc(w * h * 4 + h);
  for (let y = 0; y < h; y++) {
    scanlines[y * (w * 4 + 1)] = 0; // filter: none
    pixels.copy(scanlines, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit channels
  ihdr[9] = 6; // RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

// Area-averaged shrink to size x size, with colors weighted by alpha so edges do not darken.
function shrink(src, size) {
  const f = W / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      for (let sy = Math.floor(y * f); sy < Math.ceil((y + 1) * f); sy++) {
        const wy = Math.min(sy + 1, (y + 1) * f) - Math.max(sy, y * f);
        for (let sx = Math.floor(x * f); sx < Math.ceil((x + 1) * f); sx++) {
          const w = wy * (Math.min(sx + 1, (x + 1) * f) - Math.max(sx, x * f));
          const i = (sy * W + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha * w; g += src[i + 1] * alpha * w; b += src[i + 2] * alpha * w; a += alpha * w; weight += w;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / weight) * 255);
    }
  }
  return out;
}

// An .ico file holding one PNG per size.
function encodeIco(sizes) {
  const images = sizes.map((s) => encodePng(shrink(px, s), s, s));
  const head = Buffer.alloc(6 + sizes.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, n) => {
    const e = 6 + n * 16;
    head[e] = s >= 256 ? 0 : s;     // width (0 means 256)
    head[e + 1] = s >= 256 ? 0 : s; // height
    head.writeUInt16LE(1, e + 4);   // planes
    head.writeUInt16LE(32, e + 6);  // bits per pixel
    head.writeUInt32LE(images[n].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[n].length;
  });
  return Buffer.concat([head, ...images]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const png = encodePng(px, W, H);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
console.log('wrote', path.join(OUT_DIR, 'icon.png'), '(' + png.length + ' bytes)');
const ico = encodeIco([256, 128, 64, 48, 32, 16]);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
console.log('wrote', path.join(OUT_DIR, 'icon.ico'), '(' + ico.length + ' bytes)');
