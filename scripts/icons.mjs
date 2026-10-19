// Генератор иконок PWA: монограмма «TS» в палитре BrandMark.tsx (тёмная плашка, белые буквы).
// Без зависимостей и без сети: буквы строятся геометрически (прямоугольники и
// дуги), картинка растеризуется с supersampling 4×4, PNG кодируется вручную
// (zlib из Node).
//
//   node scripts/icons.mjs        (или: npm run icons)
//
// Выход: apps/web/public/icons/{icon-192.png, icon-512.png, apple-touch-icon.png, icon.svg}
// PNG 192/512 — maskable: фон на весь квадрат, буквы в безопасной зоне (круг 80 %).

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "apps", "web", "public", "icons");

// ---------- цвета ----------

const BG_LIGHT = hex("#1c2e26"); // лёгкий блик слева-сверху
const BG_DARK = hex("#14211b"); // фон монограммы, как в BrandMark.tsx и favicon
const INK = hex("#ffffff"); // буквы

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

// ---------- буквы ----------
// Буквы заданы в единицах высоты «u» (высота заглавной = 1u), начало координат —
// левый верхний угол надписи, y вниз. Те же размеры использует SVG ниже.

const T_WIDTH = 0.84; // ширина перекладины T
const STROKE = 0.17; // толщина штриха
// Внешний радиус дуг S. Средние линии дуг касаются в центре буквы
// (расстояние между центрами = 2·(R − STROKE/2)), поэтому штрих идёт без залома:
// 1 − 2R = 2R − STROKE  →  R = (1 + STROKE) / 4. Высота S = 1u.
const S_R = (1 + STROKE) / 4;
const GAP = 0.14; // просвет между T и S
export const TEXT_WIDTH = T_WIDTH + GAP + 2 * S_R; // ≈ 1.52u

/** Точка (x, y) в единицах «u» внутри буквы T? */
function inT(x, y) {
  if (y < 0 || y > 1) return false;
  if (y <= STROKE && x >= 0 && x <= T_WIDTH) return true; // перекладина
  const cx = T_WIDTH / 2;
  return Math.abs(x - cx) <= STROKE / 2; // ножка
}

/**
 * Буква S из двух дуг-колец: верхнее кольцо открыто справа-снизу, нижнее —
 * слева-сверху; кольца перекрываются по центру, так что штрих непрерывен.
 * x — от левого края буквы.
 */
function inS(x, y) {
  const cx = S_R;
  const cyTop = S_R;
  const cyBottom = 1 - S_R;
  const inner = S_R - STROKE;
  const dxT = x - cx;
  const dyT = y - cyTop;
  const dT = Math.hypot(dxT, dyT);
  if (dT <= S_R && dT >= inner && !(dxT > 0 && dyT > 0)) return true;
  const dyB = y - cyBottom;
  const dB = Math.hypot(dxT, dyB);
  if (dB <= S_R && dB >= inner && !(dxT < 0 && dyB < 0)) return true;
  return false;
}

/** Надпись «TS» в пикселях: левый верхний угол (ox, oy), высота букв u. */
export function inText(px, py, ox, oy, u) {
  const x = (px - ox) / u;
  const y = (py - oy) / u;
  if (inT(x, y)) return true;
  return inS(x - (T_WIDTH + GAP), y);
}

// ---------- сцена ----------

/**
 * Цвет точки (x, y) в непрерывных координатах.
 * size — сторона квадрата, textFrac — доля стороны под высоту букв.
 */
export function makeScene(size, textFrac) {
  const u = size * textFrac;
  const ox = (size - TEXT_WIDTH * u) / 2;
  const oy = (size - u) / 2;
  const hx = size * 0.3;
  const hy = size * 0.25;
  const gradR = size * 0.95;

  return function colorAt(px, py) {
    if (inText(px, py, ox, oy, u)) return INK;
    const hd = Math.hypot(px - hx, py - hy) / gradR;
    return mix(BG_LIGHT, BG_DARK, smoothstep(hd));
  };
}

/** Растеризация в RGBA с supersampling SS×SS на пиксель. */
export function render(size, textFrac, SS = 4, colorAt = makeScene(size, textFrac)) {
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
export function encodePNG(width, height, rgba) {
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
// Та же геометрия путями (без шрифтов, чтобы favicon совпадал с PNG). Скруглённые
// углы: браузер не маскирует favicon сам.

function svgIcon() {
  const S = 512;
  const u = S * 0.39;
  const ox = (S - TEXT_WIDTH * u) / 2;
  const oy = (S - u) / 2;
  const f = (v) => Number(v.toFixed(2));
  // T: перекладина и ножка
  const tBar = `<rect x="${f(ox)}" y="${f(oy)}" width="${f(T_WIDTH * u)}" height="${f(STROKE * u)}"/>`;
  const tStem = `<rect x="${f(ox + (T_WIDTH / 2 - STROKE / 2) * u)}" y="${f(oy)}" width="${f(STROKE * u)}" height="${f(u)}"/>`;
  // S: две дуги по средней линии штриха
  const sx = ox + (T_WIDTH + GAP) * u;
  const cx = sx + S_R * u;
  const rMid = (S_R - STROKE / 2) * u;
  const cyTop = oy + S_R * u;
  const cyBottom = oy + (1 - S_R) * u;
  const sPath =
    `M ${f(cx + rMid)} ${f(cyTop)} A ${f(rMid)} ${f(rMid)} 0 1 0 ${f(cx)} ${f(cyTop + rMid)} ` +
    `A ${f(rMid)} ${f(rMid)} 0 1 1 ${f(cx - rMid)} ${f(cyBottom)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <radialGradient id="bg" gradientUnits="userSpaceOnUse" cx="${f(S * 0.3)}" cy="${f(S * 0.25)}" r="${f(S * 0.95)}">
      <stop offset="0" stop-color="#1c2e26"/>
      <stop offset="1" stop-color="#14211b"/>
    </radialGradient>
  </defs>
  <rect width="${S}" height="${S}" rx="${f(S * 0.25)}" fill="url(#bg)"/>
  <rect x="${f(S * 0.0234)}" y="${f(S * 0.0234)}" width="${f(S * 0.9531)}" height="${f(S * 0.9531)}" rx="${f(S * 0.2266)}" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="${f(S * 0.047)}"/>
  <g fill="#ffffff">
    ${tBar}
    ${tStem}
  </g>
  <path d="${sPath}" fill="none" stroke="#ffffff" stroke-width="${f(STROKE * u)}"/>
</svg>
`;
}

// ---------- main ----------
// apps/mobile/scripts/icons.mjs берёт отсюда рисование и PNG; иконки PWA пишутся только при прямом запуске.

if (import.meta.main) {

  const targets = [
    { file: "icon-192.png", size: 192, textFrac: 0.39 }, // maskable: надпись в безопасной зоне 80 %
    { file: "icon-512.png", size: 512, textFrac: 0.39 },
    { file: "apple-touch-icon.png", size: 180, textFrac: 0.42 }, // iOS скругляет сам
  ];

  mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  for (const t of targets) {
    const png = encodePNG(t.size, t.size, render(t.size, t.textFrac));
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
}
