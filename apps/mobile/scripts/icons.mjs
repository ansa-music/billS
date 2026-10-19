// Иконки и заставка приложения TS для Android и iOS — та же монограмма «TS», что у PWA
// (scripts/icons.mjs в корне: геометрия букв, растеризация и PNG без зависимостей).
//
//   node scripts/icons.mjs        (или: npm run icons -w @bills/mobile)
//
// Пишет поверх файлов шаблона Capacitor:
//   android/app/src/main/res/mipmap-*/ic_launcher{,_round,_foreground}.png
//   android/app/src/main/res/drawable{,-port-*,-land-*}/splash.png, values/ic_launcher_background.xml
//   ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png (1024, без прозрачности)
//   ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG, inText, makeScene, render, TEXT_WIDTH } from '../../../scripts/icons.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(APP, 'android', 'app', 'src', 'main', 'res');
const IOS = join(APP, 'ios', 'App', 'App', 'Assets.xcassets');
const BG = '#14211b';
const BG_RGBA = [0x14, 0x21, 0x1b, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** Text centred in a w×h canvas, letters `u` px high, on `bg` (a colour or a scene function). */
function textScene(w, h, u, bg) {
  const ox = (w - TEXT_WIDTH * u) / 2;
  const oy = (h - u) / 2;
  return (px, py) => (inText(px, py, ox, oy, u) ? WHITE : typeof bg === 'function' ? bg(px, py) : bg);
}

/** Like render() of the root script, for any rectangle. */
function renderRect(w, h, colorAt, SS = 2) {
  const data = new Uint8Array(w * h * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const c = colorAt(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
          const al = c[3] / 255;
          r += c[0] * al;
          g += c[1] * al;
          b += c[2] * al;
          a += c[3];
        }
      }
      a *= inv;
      const o = (y * w + x) * 4;
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

const written = [];
function save(path, w, h, rgba) {
  if (!existsSync(dirname(path))) return; // platform not added
  const png = encodePNG(w, h, rgba);
  writeFileSync(path, png);
  written.push(`${path.replace(APP, '.').replaceAll('\\', '/')}  ${w}×${h}`);
}

// --- Android launcher icons ---------------------------------------------------
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENSITIES)) {
  const legacy = Math.round(48 * k);
  save(join(RES, `mipmap-${d}`, 'ic_launcher.png'), legacy, legacy, render(legacy, 0.36));
  // Round: the same scene clipped to a circle.
  const scene = makeScene(legacy, 0.36);
  const r = legacy / 2;
  save(join(RES, `mipmap-${d}`, 'ic_launcher_round.png'), legacy, legacy,
    renderRect(legacy, legacy, (x, y) => (Math.hypot(x - r, y - r) <= r ? scene(x, y) : CLEAR), 4));
  // Adaptive foreground: 108dp canvas, the launcher shows the inner 72dp (safe zone 66dp).
  const fg = Math.round(108 * k);
  save(join(RES, `mipmap-${d}`, 'ic_launcher_foreground.png'), fg, fg, renderRect(fg, fg, textScene(fg, fg, fg * 0.24, CLEAR), 4));
}
if (existsSync(join(RES, 'values'))) {
  writeFileSync(
    join(RES, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`,
  );
}

// --- Android splash -------------------------------------------------------------
const PORT = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [d, [w, h]] of Object.entries(PORT)) {
  save(join(RES, `drawable-port-${d}`, 'splash.png'), w, h, renderRect(w, h, textScene(w, h, Math.min(w, h) * 0.16, BG_RGBA)));
  save(join(RES, `drawable-land-${d}`, 'splash.png'), h, w, renderRect(h, w, textScene(h, w, Math.min(w, h) * 0.16, BG_RGBA)));
}
save(join(RES, 'drawable', 'splash.png'), 480, 320, renderRect(480, 320, textScene(480, 320, 320 * 0.16, BG_RGBA)));

// --- iOS ------------------------------------------------------------------------
// App Store rejects an icon with an alpha channel: the scene is opaque edge to edge, iOS rounds it.
save(join(IOS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), 1024, 1024, render(1024, 0.36, 2));
const splash = renderRect(2732, 2732, textScene(2732, 2732, 2732 * 0.08, BG_RGBA), 1);
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  save(join(IOS, 'Splash.imageset', f), 2732, 2732, splash);
}

for (const w of written) console.log(w);
