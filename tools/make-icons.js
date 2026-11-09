// Generates the PNG app icons (no dependencies): npm run icons
// Draws the robot face (black bg, white eyes, pink blush, smile) with 4x4 supersampling.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "public", "icons");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// shape tests in 512-unit space (same shapes as public/icons/icon.svg)
const inRoundRect = (x, y, rx, ry, w, h, r) => {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inEllipse = (x, y, cx, cy, a, b) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1;
const inSmile = (x, y) => {
  const d = Math.hypot(x - 256, y - 312);
  return d > 21 && d < 31 && y > 318;
};

// returns [r,g,b,a] for a sample; `maskable` = full-bleed background + smaller face
function sample(x, y, maskable) {
  if (maskable) { x = (x - 256) / 0.78 + 256; y = (y - 256) / 0.78 + 256; }
  const bg = maskable ? true : inRoundRect(x, y, 0, 0, 512, 512, 112);
  if (!bg) return [0, 0, 0, 0];
  if (inRoundRect(x, y, 136, 150, 88, 128, 40) || inRoundRect(x, y, 288, 150, 88, 128, 40) || inSmile(x, y))
    return [255, 255, 255, 255];
  if (inEllipse(x, y, 118, 322, 40, 18) || inEllipse(x, y, 394, 322, 40, 18))
    return [Math.round(255 * 0.75), Math.round(122 * 0.75), Math.round(168 * 0.75), 255];
  return [0, 0, 0, 255];
}

function render(size, maskable = false) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const x = ((px + (sx + 0.5) / ss) / size) * 512;
        const y = ((py + (sy + 0.5) / ss) / size) * 512;
        const c = sample(x, y, maskable);
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
      }
      const i = (py * size + px) * 4;
      buf[i] = a ? r / a : 0; buf[i + 1] = a ? g / a : 0; buf[i + 2] = a ? b / a : 0; buf[i + 3] = a / (ss * ss);
    }
  }
  return png(size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon-192.png"), render(192));
fs.writeFileSync(path.join(OUT, "icon-512.png"), render(512));
fs.writeFileSync(path.join(OUT, "icon-maskable-512.png"), render(512, true));
console.log("icons written to", OUT);
