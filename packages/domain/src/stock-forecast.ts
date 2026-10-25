/**
 * Stock forecast for products with tracked stock: how fast each one sells in every
 * hour of the day over the last 14 days → «закончится примерно в 15:00» today, or
 * «хватит на 3 дня», and how many to buy for a week. Plain arithmetic on the
 * venue's own sales; works offline.
 */
import { WORKDAY_START_HOUR } from './cafe.ts';
import { zonedParts } from './time.ts';

export const STOCK_WINDOW_DAYS = 14;
/** Less history than this — no forecast yet (one busy day would mislead). */
export const STOCK_MIN_HISTORY_DAYS = 3;
/** Fewer units sold in the window — too few to say when it runs out. */
export const STOCK_MIN_UNITS = 3;
export const STOCK_BUY_DAYS = 7;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface StockForecastInput {
  now: number;
  timezone: string;
  /** Products whose stock is tracked (stock ≥ 0). */
  products: ReadonlyArray<{ id: string; name: string; stock: number }>;
  /** Units sold (orders not cancelled), any period: only the last 14 days count. */
  sales: ReadonlyArray<{ productId: string; at: number; qty: number }>;
  /**
   * Days of sales history the venue has (from its first order), capped at 14.
   * A new venue with 5 days of sales divides by 5, not 14.
   */
  historyDays: number;
}

export interface StockForecastItem {
  productId: string;
  name: string;
  stock: number;
  /** Today (before the working day ends at 06:00) when it runs out; null — lasts past today or no forecast. */
  runsOutAt: number | null;
  /** Whole days it lasts when it does not run out today; 0 — out of stock; null — no forecast. */
  daysLeft: number | null;
  /** Units to buy so a week of sales is covered: ⌈per day × 7 − stock⌉, never negative. */
  buyForWeek: number;
  /** Average units sold per day; null — no forecast. */
  perDay: number | null;
}

/** Minutes until the working day ends (next WORKDAY_START_HOUR:00 local). */
function minutesToDayEnd(minuteOfDay: number): number {
  const end = WORKDAY_START_HOUR * 60;
  const left = (end - minuteOfDay + 1440) % 1440;
  return left === 0 ? 1440 : left;
}

/**
 * When the stock runs out today at the hourly pace `rate` (units per hour for each
 * local hour), or null if it lasts until the working day ends.
 */
export function runsOutToday(now: number, timezone: string, stock: number, rate: readonly number[]): number | null {
  if (stock <= 0) return null;
  const p = zonedParts(now, timezone);
  let minute = p.minuteOfDay + p.second / 60;
  let left = minutesToDayEnd(p.minuteOfDay) - p.second / 60;
  let t = now;
  let sold = 0;
  while (left > 0) {
    const hour = Math.floor(minute / 60) % 24;
    const chunk = Math.min(60 - (minute % 60), left);
    const expected = ((rate[hour] ?? 0) * chunk) / 60;
    if (expected > 0 && sold + expected >= stock) {
      return Math.round(t + ((stock - sold) / expected) * chunk * MINUTE);
    }
    sold += expected;
    t += chunk * MINUTE;
    minute = (minute + chunk) % 1440;
    left -= chunk;
  }
  return null;
}

/** Forecast for every product, the ones that run out soonest first. */
export function forecastStock(input: StockForecastInput): StockForecastItem[] {
  const days = Math.min(STOCK_WINDOW_DAYS, Math.max(0, input.historyDays));
  const since = input.now - STOCK_WINDOW_DAYS * DAY;
  const tracked = new Set(input.products.map((p) => p.id));
  const hourly = new Map<string, number[]>();
  const units = new Map<string, number>();
  for (const s of input.sales) {
    if (!tracked.has(s.productId) || s.at < since || s.at > input.now || s.qty <= 0) continue;
    const h = Math.floor(zonedParts(s.at, input.timezone).minuteOfDay / 60);
    const row = hourly.get(s.productId) ?? new Array<number>(24).fill(0);
    row[h]! += s.qty;
    hourly.set(s.productId, row);
    units.set(s.productId, (units.get(s.productId) ?? 0) + s.qty);
  }

  const items = input.products.map((p): StockForecastItem => {
    const stock = Math.max(0, Math.trunc(p.stock));
    const sold = units.get(p.id) ?? 0;
    const base = { productId: p.id, name: p.name, stock };
    if (days < STOCK_MIN_HISTORY_DAYS || sold === 0) {
      return { ...base, runsOutAt: null, daysLeft: stock === 0 ? 0 : null, buyForWeek: 0, perDay: null };
    }
    const perDay = sold / days;
    const buyForWeek = Math.max(0, Math.ceil(perDay * STOCK_BUY_DAYS - stock - 1e-9));
    if (sold < STOCK_MIN_UNITS) {
      return { ...base, runsOutAt: null, daysLeft: stock === 0 ? 0 : null, buyForWeek, perDay: round1(perDay) };
    }
    if (stock === 0) return { ...base, runsOutAt: null, daysLeft: 0, buyForWeek, perDay: round1(perDay) };
    const rate = (hourly.get(p.id) ?? []).map((q) => q / days);
    const runsOutAt = runsOutToday(input.now, input.timezone, stock, rate);
    const daysLeft = runsOutAt !== null ? null : Math.max(1, Math.floor(stock / perDay));
    return { ...base, runsOutAt, daysLeft, buyForWeek, perDay: round1(perDay) };
  });

  const rank = (i: StockForecastItem) =>
    i.daysLeft === 0 ? -1 : i.runsOutAt !== null ? i.runsOutAt : i.daysLeft !== null ? input.now + i.daysLeft * DAY : Infinity;
  return items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ru'));
}

/** «Закупить на неделю»: products to buy, most units first. */
export function purchaseList(items: readonly StockForecastItem[]): StockForecastItem[] {
  return items.filter((i) => i.buyForWeek > 0).sort((a, b) => b.buyForWeek - a.buyForWeek || a.name.localeCompare(b.name, 'ru'));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
