import { RECEIPT_LIMITS } from '@bills/domain';

/** What a person may upload as a receipt logo, before it is converted. */
export const LOGO_FILE_MAX = 2 * 1024 * 1024;
/** A 58/80 mm head prints 384/576 dots a line; the logo stays small on either. */
const MAX_WIDTH = 384;
const MAX_HEIGHT = 160;

export class LogoError extends Error {}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new LogoError('Не удалось открыть картинку — возьмите PNG или JPEG');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Otsu's threshold over 256 grey levels: splits ink from paper for light and dark logos alike. */
function otsu(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i]!;
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    weightB += histogram[i]!;
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += i * histogram[i]!;
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/** Draws the picture at `scale`, turns it into pure black and white and crops the white margins. */
function toMonochrome(img: HTMLImageElement, scale: number): string | null {
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new LogoError('Этот браузер не умеет обрабатывать картинки');
  // Transparent parts are paper.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const grey = new Uint8Array(w * h);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < grey.length; i++) {
    const g = Math.round(0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!);
    grey[i] = g;
    histogram[g]!++;
  }
  // A plain white picture has nothing to print.
  const threshold = Math.min(otsu(histogram, grey.length), 230);
  let top = h;
  let bottom = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ink = grey[i]! <= threshold;
      const v = ink ? 0 : 255;
      px[i * 4] = v;
      px[i * 4 + 1] = v;
      px[i * 4 + 2] = v;
      px[i * 4 + 3] = 255;
      if (ink) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return null;
  ctx.putImageData(image, 0, 0);
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d')!.drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
  return out.toDataURL('image/png');
}

/**
 * A receipt logo from a picture: at most 384 × 160 dots, pure black and white (a thermal head
 * prints no grey), white margins cropped, small enough for the club settings.
 */
export async function toReceiptLogo(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new LogoError('Нужна картинка: PNG, JPEG, WebP или SVG');
  if (file.size > LOGO_FILE_MAX) throw new LogoError(`Файл больше 2 МБ (${Math.round(file.size / 1024 / 1024)} МБ) — уменьшите картинку`);
  const img = await loadImage(file);
  if (!img.naturalWidth || !img.naturalHeight) throw new LogoError('Пустая картинка');
  let scale = Math.min(1, MAX_WIDTH / img.naturalWidth, MAX_HEIGHT / img.naturalHeight);
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = toMonochrome(img, scale);
    if (url === null) throw new LogoError('На картинке нечего печатать: она почти белая');
    if (url.length <= RECEIPT_LIMITS.logo) return url;
    scale *= 0.75;
  }
  throw new LogoError('Логотип слишком сложный для чека — возьмите картинку проще');
}
