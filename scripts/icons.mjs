// Генератор иконок PWA: «шар 8» на тёмном фоне.
// Без зависимостей и без сети: PNG кодируется вручную (zlib из Node),
// картинка растеризуется аналитически с supersampling 4×4.
//
//   node scripts/icons.mjs
//
// Выход: apps/web/public/icons/{icon-192.png, icon-512.png, apple-touch-icon.png, icon.svg}

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "apps", "web", "public", "icons");

// ---------- цвета ----------

const BG = hex("#0e1311"); // theme-color интерфейса
const BALL_LIGHT = hex("#4a4a4a"); // блик
const BALL_DARK = hex("#050505"); // край шара
const WHITE_TOP = hex("#ffffff");
const WHITE_BOTTOM = hex("#e4e4e4");
const DIGIT = hex("#0a0a0a");

function hex(s) {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t), lerp(c1[3], c2[3], t)];
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

// ---------- сцена ----------

/**
 * Цвет точки (x, y) в непрерывных координатах.
 * size — сторона квадрата, ballFrac — доля стороны под диаметр шара.
 */
function makeScene(size, ballFrac) {
  const cx = size / 2;
  const cy = size / 2;
  const r = (size * ballFrac) / 2; // радиус шара

  // блик: 35% / 30% от bounding box шара
  const hx = cx - r + 0.35 * 2 * r;
  const hy = cy - r + 0.3 * 2 * r;
  const gradR = r * 1.45;

  // белый круг ~48% диаметра шара
  const wr = r * 0.48;
  const D = wr * 2; // диаметр белого круга

  // цифра «8»: два кольца, верхнее чуть меньше нижнего
  const stroke = D * 0.105; // толщина линии
  const ru = D * 0.175; // внешний радius верхнего кольца
  const rl = D * 0.2; // внешний радиус нижнего кольца
  const yu = cy - D * 0.175; // центр верхнего
  const yl = cy + D * 0.15; // центр нижнего
  const xScale = 1 / 0.94; // кольца чуть сплюснуты по горизонтали, как у настоящей восьмёрки

  function ring(px, py, ox, oy, R) {
    const dx = (px - ox) * xScale;
    const dy = py - oy;
    const d = Math.hypot(dx, dy);
    return d <= R && d >= R - stroke;
  }

  return function colorAt(px, py) {
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    if (d > r) return BG;

    if (d <= wr) {
      if (ring(px, py, cx, yu, ru) || ring(px, py, cx, yl, rl)) return DIGIT;
      // лёгкая вертикальная тень на белом круге
      const t = clamp01((py - (cy - wr)) / D);
      return mix(WHITE_TOP, WHITE_BOTTOM, t);
    }

    // чёрный шар: радиальный градиент от блика к краю
    const hd = Math.hypot(px - hx, py - hy) / gradR;
    let c = mix(BALL_LIGHT, BALL_DARK, smoothstep(hd));
    // тонкая тёмная кромка по краю шара
    const edge = clamp01((d - r * 0.9) / (r * 0.1));
    c = mix(c, BALL_DARK, edge * 0.5);
    return c;
  };
}

/** Растеризация в RGBA с supersampling SS×SS на пиксель. */
function render(size, ballFrac, SS = 4) {
  const colorAt = makeScene(size, ballFrac);
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < SS; j++) {
        const py = y + (j + 0.5) / SS;
        for (let i = 0; i < SS; i++) {
          const px = x + (i + 0.5) / SS;
          const c = colorAt(px, py);
          // премультипликация по альфе, чтобы прозрачный фон не красил кромку
          const al = c[3] / 255;
          r += c[0] * al;
          g += c[1] * al;
          b += c[2] * al;
          a += c[3];
        }
      }
      a *= inv;
      const o = (y * size + x) * 4;
      if (a > 0) {
        const k = inv / (a / 255);
        data[o] = Math.round(r * k);
        data[o + 1] = Math.round(g * k);
        data[o + 2] = Math.round(b * k);
      }
      data[o + 3] = Math.round(a);
    }
  }
  return data;
}

// ---------- PNG ----------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** Кодирует RGBA-буфер в PNG (8 бит, color type 6, фильтр 0 на каждую строку). */
function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- SVG ----------

function svgIcon() {
  const S = 512;
  const c = S / 2;
  const r = (S * 0.7) / 2; // 179.2
  const wr = r * 0.48; // 86
  const D = wr * 2;
  const fontSize = (D * 0.7) / 0.716; // высота цифры ≈ 70% белого круга (cap-height Arial ≈ 0.716em)
  const baseline = c + D * 0.35;
  const hx = c - r + 0.35 * 2 * r;
  const hy = c - r + 0.3 * 2 * r;
  const f = (v) => Number(v.toFixed(2));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <radialGradient id="ball" gradientUnits="userSpaceOnUse" cx="${f(hx)}" cy="${f(hy)}" r="${f(r * 1.45)}">
      <stop offset="0" stop-color="#4a4a4a"/>
      <stop offset="1" stop-color="#050505"/>
    </radialGradient>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e4e4e4"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="#0e1311"/>
  <circle cx="${c}" cy="${c}" r="${f(r)}" fill="url(#ball)"/>
  <circle cx="${c}" cy="${c}" r="${f(wr)}" fill="url(#face)"/>
  <text x="${c}" y="${f(baseline)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${f(fontSize)}" fill="#0a0a0a">8</text>
</svg>
`;
}

// ---------- main ----------

const targets = [
  { file: "icon-192.png", size: 192, ballFrac: 0.7 }, // maskable: шар в безопасной зоне 80%
  { file: "icon-512.png", size: 512, ballFrac: 0.7 },
  { file: "apple-touch-icon.png", size: 180, ballFrac: 0.8 }, // iOS скругляет сам
];

mkdirSync(OUT_DIR, { recursive: true });

const written = [];
for (const t of targets) {
  const png = encodePNG(t.size, t.size, render(t.size, t.ballFrac));
  const path = join(OUT_DIR, t.file);
  writeFileSync(path, png);
  written.push({ path, bytes: png.length, dims: `${t.size}×${t.size}` });
}

const svg = svgIcon();
const svgPath = join(OUT_DIR, "icon.svg");
writeFileSync(svgPath, svg, "utf8");
written.push({ path: svgPath, bytes: Buffer.byteLength(svg, "utf8"), dims: "vector" });

for (const w of written) {
  console.log(`${w.path.replace(ROOT, ".").replaceAll("\\", "/")}  ${w.dims}  ${w.bytes} bytes`);
}
