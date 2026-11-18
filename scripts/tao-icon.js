// Vẽ icon PNG (chuông nhắc cước) cho app – không cần thư viện ngoài.
// Chạy: npm run tao-icon
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public', 'app', 'icons');
fs.mkdirSync(OUT, { recursive: true });

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Hình trong hệ toạ độ 0..1. Trả về màu [r,g,b,a] tại điểm (x,y).
const BLUE = [31, 111, 235, 255], WHITE = [255, 255, 255, 255], ORANGE = [255, 176, 32, 255], NONE = [0, 0, 0, 0];
function shape(x, y, { rounded, scale, mono }) {
  // nền
  let bg = NONE;
  if (mono) bg = NONE;
  else if (rounded) {
    const r = 0.22, cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) bg = BLUE;
  } else bg = BLUE;
  // co nhỏ chuông vào giữa (vùng an toàn cho icon maskable)
  const u = 0.5 + (x - 0.5) / scale, v = 0.5 + (y - 0.5) / scale;
  const fg = mono ? WHITE : WHITE;
  // thân chuông: vòm tròn + thân loe + vành
  const dome = (u - 0.5) ** 2 + (v - 0.42) ** 2 <= 0.205 ** 2 && v <= 0.42;
  const t = (v - 0.42) / (0.68 - 0.42);
  const half = 0.205 + t * 0.07;
  const body = v >= 0.42 && v <= 0.68 && Math.abs(u - 0.5) <= half;
  const rimDx = Math.max(0, Math.abs(u - 0.5) - 0.28);
  const rim = v >= 0.66 && v <= 0.71 && rimDx ** 2 + Math.max(0, Math.abs(v - 0.685) - 0.005) ** 2 <= 0.022 ** 2;
  const clapper = (u - 0.5) ** 2 + (v - 0.775) ** 2 <= 0.07 ** 2 && v >= 0.72;
  const knob = (u - 0.5) ** 2 + (v - 0.205) ** 2 <= 0.04 ** 2;
  if (dome || body || rim || clapper || knob) return fg;
  // chấm cam báo
  if (!mono) {
    const d = (u - 0.72) ** 2 + (v - 0.27) ** 2;
    if (d <= 0.085 ** 2) return ORANGE;
    if (d <= 0.11 ** 2 && bg !== NONE) return BLUE;
  }
  return bg;
}
function render(size, opts) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = shape((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opts);
          const a = c[3] / 255;
          acc[0] += c[0] * a; acc[1] += c[1] * a; acc[2] += c[2] * a; acc[3] += a;
        }
      const i = (y * size + x) * 4;
      const a = acc[3] / (SS * SS);
      px[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      px[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      px[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      px[i + 3] = Math.round(a * 255);
    }
  return png(size, px);
}

const files = {
  'icon-192.png': render(192, { rounded: true, scale: 1 }),
  'icon-512.png': render(512, { rounded: true, scale: 1 }),
  'icon-maskable-512.png': render(512, { rounded: false, scale: 0.78 }),
  'icon-180.png': render(180, { rounded: false, scale: 0.9 }), // iPhone tự bo góc
  'badge-96.png': render(96, { mono: true, scale: 1.05 }),
};
for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), buf);
console.log('Đã tạo icon tại', OUT);
