/**
 * «Умные подсказки»: plain rules over the last 28 days of the venue's own data —
 * no AI service, no internet. Each rule looks at one thing (busy hours, slow menu
 * items, the average check, cash counts…), stays silent until it has enough data,
 * and otherwise returns one card in plain words with the numbers behind it.
 * `buildInsights` runs them all and keeps the most important five.
 *
 * Money is in minor units (rule 6); times are epoch ms; hours and weekdays are
 * read in the venue's time zone.
 */
import type { BusinessType } from './cafe.ts';
import { workingDay } from './cafe.ts';
import type { Minor } from './money.ts';
import { formatMoney, minorPerMajor } from './money.ts';
import { zonedParts } from './time.ts';
import type { StockForecastItem } from './stock-forecast.ts';

export type InsightSeverity = 'tip' | 'warn' | 'good';

export interface InsightAction {
  label: string;
  /** Screen route with an optional query: `/bar`, `/settings?tab=tariffs`. */
  route: string;
}

export interface InsightCard {
  /** Rule id: `peak-hours`, `slow-items`, … — stable, one card per rule. */
  id: string;
  severity: InsightSeverity;
  /** One line. */
  title: string;
  /** The numbers behind it and what to do. */
  detail: string;
  action?: InsightAction;
}

/** GET /api/insights. */
export interface InsightsView {
  generatedAt: number;
  /** Days of sales history the HUB has (≤ 28): fewer than 7 — the empty state. */
  historyDays: number;
  cards: InsightCard[];
  /** Products with tracked stock: when they run out, what to buy for a week. */
  stock: StockForecastItem[];
}

export interface InsightsInput {
  now: number;
  timezone: string;
  currency: string;
  business: BusinessType;
  /** Guests coming in, for busy hours: counter orders (cafe) or games started (billiards). */
  visits: readonly number[];
  /** The menu now. `onMenu` — active product in an active category. */
  products: ReadonlyArray<{ id: string; name: string; createdAt: number; onMenu: boolean }>;
  /** Lines of orders that were not cancelled. */
  sales: ReadonlyArray<{ productId: string; name: string; at: number; qty: number; amount: Minor }>;
  /** Fully paid checks: when and how much came in for them (refunds already taken off). */
  checks: ReadonlyArray<{ at: number; amount: Minor }>;
  /** Money in (positive) and refunds (negative), for revenue by day. */
  payments: ReadonlyArray<{ at: number; amount: Minor }>;
  /** Counter orders that reached «Готово» (cafe). */
  prep: ReadonlyArray<{ at: number; readyAt: number }>;
  /** Games that were played (billiards); `stoppedAt` null — still running. */
  games: ReadonlyArray<{ tableId: string; startedAt: number; stoppedAt: number | null; prepaid: boolean }>;
  tables: ReadonlyArray<{ id: string; name: string }>;
  /** Closed cash shifts with a count: difference = counted − expected. */
  shifts: ReadonlyArray<{ number: number; closedAt: number; difference: Minor }>;
  /** Orders (and games) taken, cancelled or not: for the share of cancellations. */
  voids: ReadonlyArray<{ at: number; cancelled: boolean }>;
}

export const INSIGHTS_WINDOW_DAYS = 28;
export const INSIGHTS_MAX_CARDS = 5;
/** Below this much history no rule speaks: «Подсказки появятся, когда накопится неделя продаж». */
export const INSIGHTS_MIN_HISTORY_DAYS = 7;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Thresholds of every rule, in one place: tests and the README refer to them. */
export const INSIGHT_RULES = {
  peakHours: { minVisits: 60, minRatio: 1.8, minPerHour: { cafe: 4, billiards: 1.5 }, windowHours: 3 },
  slowItems: { minProducts: 5, minUnits: 100, minDaysOnMenu: 14, maxShareOfAverage: 0.15, maxUnits: 6 },
  topSeller: { minUnits: 50, minProducts: 3, minShare: 0.25 },
  avgCheck: { minChecks: 20, minChange: 0.1 },
  revenueDay: { minChange: 0.3, minPastDays: 2 },
  prepTrend: { minOrders: 30, minChange: 0.2, minDiffMs: 30_000, maxPrepMs: 60 * MINUTE },
  slowHour: { minOrders: 50, minPerHour: 10, minRatio: 1.5, minDiffMs: 60_000 },
  tableIdle: { minGames: 30, minTables: 2, idleShare: 0.05, maxDaypartShare: 0.5, minDaypartGames: 3 },
  prepaid: { minGames: 30, maxShare: 0.2, minAvgMs: 50 * MINUTE },
  gameLength: { minGames: 15, minChange: 0.2 },
  cash: { minMajor: 100, bigMajor: 1000 },
  voids: { minOrders: 40, minCancelled: 5, minShare: 0.05, baselineFactor: 2, shareWithoutBaseline: 0.08 },
} as const;

// ── Words and numbers ─────────────────────────────────────────────────────────

/** Russian plural: plural(5, ['заказ', 'заказа', 'заказов']) → 'заказов'. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(Math.trunc(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

/** 2,4 — one decimal at most, Russian comma. */
function num1(n: number): string {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function pct(share: number): string {
  return `${num1(Math.round(share * 1000) / 10)}%`;
}

function pctWhole(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** «40 с», «6 мин 10 с», «12 мин», «1 ч 35 мин». */
export function formatInsightDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec} с`;
  const totalMin = Math.round(totalSec / 60);
  if (totalSec < 10 * 60) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s ? `${m} мин ${s} с` : `${m} мин`;
  }
  if (totalMin < 60) return `${totalMin} мин`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** Dative plural, «по субботам». Index = ISO weekday. */
const WEEKDAY_EVERY = ['', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям'];

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function sum(values: readonly number[]): number {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** ISO weekday of a calendar date YYYY-MM-DD. */
function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const js = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return js === 0 ? 7 : js;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 12.10 from YYYY-MM-DD. */
function shortDate(date: string): string {
  const [, m = '', d = ''] = date.split('-');
  return `${d}.${m}`;
}

/** «за 4 недели» for the full window, «за 16 дней» for less. */
function periodWords(days: number): string {
  const d = Math.max(1, Math.round(days));
  if (d >= INSIGHTS_WINDOW_DAYS) return 'за 4 недели';
  if (d % 7 === 0) return `за ${d / 7} ${plural(d / 7, ['неделю', 'недели', 'недель'])}`;
  return `за ${d} ${plural(d, ['день', 'дня', 'дней'])}`;
}

/**
 * Days of history: from the earliest sale, visit, check or payment inside the
 * window up to now, at most 28. 0 when there is nothing at all.
 */
export function historyDays(input: Pick<InsightsInput, 'now' | 'visits' | 'sales' | 'checks' | 'payments'>): number {
  const since = input.now - INSIGHTS_WINDOW_DAYS * DAY;
  let first = Infinity;
  const see = (at: number) => {
    if (at >= since && at <= input.now && at < first) first = at;
  };
  input.visits.forEach(see);
  for (const s of input.sales) see(s.at);
  for (const c of input.checks) see(c.at);
  for (const p of input.payments) see(p.at);
  if (first === Infinity) return 0;
  return Math.min(INSIGHTS_WINDOW_DAYS, (input.now - first) / DAY);
}

interface Candidate {
  card: InsightCard;
  /** Higher first: warn 300+, tip 200+, good 100+, plus how strong the signal is. */
  score: number;
}

const BASE: Record<InsightSeverity, number> = { warn: 300, tip: 200, good: 100 };

function candidate(card: InsightCard, strength: number): Candidate {
  return { card, score: BASE[card.severity] + Math.max(0, Math.min(99, strength)) };
}

function inWindow<T extends { at: number }>(rows: readonly T[], now: number, days = INSIGHTS_WINDOW_DAYS): T[] {
  const since = now - days * DAY;
  return rows.filter((r) => r.at >= since && r.at <= now);
}

// ── Rules ─────────────────────────────────────────────────────────────────────

/** Busiest weekday × 3-hour slot against an average open hour → staff up. */
export function peakHoursRule(input: InsightsInput): Candidate | null {
  const cfg = INSIGHT_RULES.peakHours;
  const since = input.now - INSIGHTS_WINDOW_DAYS * DAY;
  const visits = input.visits.filter((at) => at >= since && at <= input.now);
  if (visits.length < cfg.minVisits) return null;
  const span = Math.min(INSIGHTS_WINDOW_DAYS, (input.now - Math.min(...visits)) / DAY);
  if (span < INSIGHTS_MIN_HISTORY_DAYS) return null;

  // How many of each weekday the history covers: averages per day, not totals.
  const days = Math.max(1, Math.ceil(span));
  const occurrences = new Array<number>(8).fill(0);
  for (let i = 0; i < days; i++) occurrences[zonedParts(input.now - i * DAY, input.timezone).weekday]! += 1;

  const counts = Array.from({ length: 8 }, () => new Array<number>(24).fill(0));
  for (const at of visits) {
    const p = zonedParts(at, input.timezone);
    counts[p.weekday]![Math.floor(p.minuteOfDay / 60)]! += 1;
  }
  const perHour = counts.map((row, w) => row.map((c) => (occurrences[w]! > 0 ? c / occurrences[w]! : 0)));
  const open = perHour.slice(1).flat().filter((v) => v > 0);
  if (open.length === 0) return null;
  const baseline = sum(open) / open.length;

  let best = { w: 0, h: 0, avg: 0 };
  for (let w = 1; w <= 7; w++) {
    for (let h = 0; h + cfg.windowHours <= 24; h++) {
      const avg = sum(perHour[w]!.slice(h, h + cfg.windowHours)) / cfg.windowHours;
      if (avg > best.avg) best = { w, h, avg };
    }
  }
  const ratio = best.avg / baseline;
  if (ratio < cfg.minRatio || best.avg < cfg.minPerHour[input.business]) return null;

  const cafe = input.business === 'cafe';
  const what = cafe ? 'заказов' : 'игр';
  const hours = `${best.h}–${best.h + cfg.windowHours}`;
  const perHourNow = Math.round(best.avg * 10) / 10;
  const usual = Math.round(baseline * 10) / 10;
  return candidate(
    {
      id: 'peak-hours',
      severity: 'tip',
      title: `По ${WEEKDAY_EVERY[best.w]} ${hours} ${what} в ${num1(Math.round(ratio * 10) / 10)} раза больше — ${
        cafe ? 'поставьте второго бариста' : 'поставьте второго администратора'
      }`,
      detail: `В эти часы в среднем ${num1(perHourNow)} ${what} в час, в обычный час — ${num1(usual)}. Посчитано ${periodWords(span)}.`,
      action: { label: 'Сотрудники', route: '/staff' },
    },
    ratio * 15,
  );
}

/** Menu items nobody orders, with at least two weeks on the menu → remove or promote. */
export function slowItemsRule(input: InsightsInput): Candidate | null {
  const cfg = INSIGHT_RULES.slowItems;
  const sales = inWindow(input.sales, input.now);
  if (sum(sales.map((s) => s.qty)) < cfg.minUnits) return null;
  const qty = new Map<string, number>();
  for (const s of sales) qty.set(s.productId, (qty.get(s.productId) ?? 0) + s.qty);

  const eligible = input.products
    .filter((p) => p.onMenu && input.now - p.createdAt >= cfg.minDaysOnMenu * DAY)
    .map((p) => {
      const days = Math.min(INSIGHTS_WINDOW_DAYS, (input.now - p.createdAt) / DAY);
      const units = qty.get(p.id) ?? 0;
      return { ...p, days, units, rate: units / days };
    });
  if (eligible.length < cfg.minProducts) return null;
  const avgRate = sum(eligible.map((p) => p.rate)) / eligible.length;
  if (avgRate <= 0) return null;

  const slow = eligible
    .filter((p) => p.rate <= avgRate * cfg.maxShareOfAverage && p.units <= cfg.maxUnits)
    .sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name, 'ru'));
  const first = slow[0];
  if (!first) return null;

  const times = (n: number) => `${n} ${plural(n, ['раз', 'раза', 'раз'])}`;
  const title =
    first.units === 0
      ? `«${first.name}» не заказали ни разу ${periodWords(first.days)} — уберите или сделайте акцию`
      : `«${first.name}» продали ${times(first.units)} ${periodWords(first.days)} — уберите или сделайте акцию`;
  const typical = Math.round(avgRate * first.days);
  const others = slow.slice(1, 4).map((p) => `${p.name} — ${p.units}`);
  const detail =
    `Обычная позиция меню за это время продаётся ${times(typical)}.` +
    (others.length ? ` Ещё редко берут: ${others.join(', ')}.` : '');
  return candidate(
    { id: 'slow-items', severity: 'tip', title, detail, action: { label: 'Открыть меню', route: '/bar' } },
    30 + slow.length * 5,
  );
}

/** One item brings a big part of the menu money → keep it in stock. */
export function topSellerRule(input: InsightsInput): Candidate | null {
  const cfg = INSIGHT_RULES.topSeller;
  const sales = inWindow(input.sales, input.now);
  if (sum(sales.map((s) => s.qty)) < cfg.minUnits) return null;
  if (historyDays(input) < INSIGHTS_MIN_HISTORY_DAYS) return null;
  const by = new Map<string, { name: string; amount: number; units: number }>();
  for (const s of sales) {
    const row = by.get(s.productId) ?? { name: s.name, amount: 0, units: 0 };
    row.amount += s.amount;
    row.units += s.qty;
    by.set(s.productId, row);
  }
  if (by.size < cfg.minProducts) return null;
  const names = new Map(input.products.map((p) => [p.id, p.name]));
  const total = sum([...by.values()].map((r) => r.amount));
  if (total <= 0) return null;
  const [id, top] = [...by].sort((a, b) => b[1].amount - a[1].amount)[0]!;
  const share = top.amount / total;
  if (share < cfg.minShare) return null;
  const name = names.get(id) ?? top.name;
  return candidate(
    {
      id: 'top-seller',
      severity: 'good',
      title: `«${name}» — ${pctWhole(share)} выручки меню`,
      detail:
        `${capitalize(periodWords(historyDays(input)))} — ${top.units} шт. на ${formatMoney(top.amount, input.currency)}. ` +
        (input.business === 'cafe'
          ? 'Следите, чтобы для него всегда хватало продуктов, и предлагайте к нему добавку или десерт.'
          : 'Следите, чтобы он всегда был в наличии.'),
    },
    share * 50,
  );
}

/** Average paid check this week against the week before. */
export function avgCheckRule(input: InsightsInput): Candidate | null {
  const cfg = INSIGHT_RULES.avgCheck;
  const cur = input.checks.filter((c) => c.at > input.now - WEEK && c.at <= input.now);
  const prev = input.checks.filter((c) => c.at > input.now - 2 * WEEK && c.at <= input.now - WEEK);
  if (cur.length < cfg.minChecks || prev.length < cfg.minChecks) return null;
  const a = sum(cur.map((c) => c.amount)) / cur.length;
  const b = sum(prev.map((c) => c.amount)) / prev.length;
  if (b <= 0) return null;
  const change = a / b - 1;
  if (Math.abs(change) < cfg.minChange) return null;
  const money = (v: number) => formatMoney(Math.round(v), input.currency);
  const checks = (n: number) => `${n} ${plural(n, ['чек', 'чека', 'чеков'])}`;
  const numbers = `${money(a)} за последние 7 дней против ${money(b)} неделей раньше (${checks(cur.length)} и ${checks(prev.length)}).`;
  if (change > 0) {
    return candidate(
      { id: 'avg-check', severity: 'good', title: `Средний чек вырос на ${pctWhole(change)}`, detail: numbers },
      change * 100,
    );
  }
  return candidate(
    {
      id: 'avg-check',
      severity: 'warn',
      title: `Средний чек упал на ${pctWhole(-change)}`,
      detail: `${numbers} ${
        input.business === 'cafe'
          ? 'Предлагайте к напитку десерт или размер побольше.'
          : 'Предлагайте к игре напитки и закуски из бара.'
      }`,
    },
    -change * 100,
  );
}

/** Yesterday's revenue against the same weekday of the three weeks before (±30%). */
export function revenueDayRule(input: InsightsInput): Candidate | null {
  const cfg = INSIGHT_RULES.revenueDay;
  const byDay = new Map<string, number>();
  for (const p of inWindow(input.payments, input.now)) {
    const d = workingDay(p.at, input.timezone);
    byDay.set(d, (byDay.get(d) ?? 0) + p.amount);
  }
  const yesterday = shiftDate(workingDay(input.now, input.timezone), -1);
  const value = byDay.get(yesterday) ?? 0;
  // Nothing at all — likely a day off, not a bad day.
  if (value <= 0) return null;
  const past = [7, 14, 21].map((n) => byDay.get(shiftDate(yesterday, -n)) ?? 0).filter((v) => v > 0);
  if (past.length < cfg.minPastDays) return null;
  const usual = sum(past) / past.length;
  const change = value / usual - 1;
  if (Math.abs(change) < cfg.minChange) return null;
  const every = WEEKDAY_EVERY[weekdayOfDate(yesterday)];
  const numbers = `${formatMoney(value, input.currency)} против ${formatMoney(Math.round(usual), input.currency)} в среднем по прошлым ${every}.`;
  if (change > 0) {
    return candidate(
      {
        id: 'revenue-day',
        severity: 'good',
        title: `Вчера выручка на ${pctWhole(change)} выше, чем обычно по ${every}`,
        detail: `${numbers} Вспомните, что сработало, — это можно повторить.`,
      },
      change * 50,
    );
  }
  return candidate(
    {
      id: 'revenue-day',
      severity: 'warn',
      title: `Вчера выручка на ${pctWhole(-change)} ниже, чем обычно по ${every}`,
      detail: `${numbers} Если понятной причины нет (праздник, погода, ремонт), загляните в журнал: отмены и возвраты за день.`,
      action: { label: 'Журнал', route: '/journal' },
    },
    -change * 100,
  );
}

function prepTimes(input: InsightsInput, from: number, to: number): Array<{ at: number; ms: number }> {
  const max = INSIGHT_RULES.prepTrend.maxPrepMs;
  return input.prep
    .filter((p) => p.at > from && p.at <= to)
    .map((p) => ({ at: p.at, ms: p.readyAt - p.at }))
    // An order marked ready an hour later was forgotten on the screen, not made slowly.
    .filter((p) => p.ms >= 0 && p.ms <= max);
}

/** Cafe: typical time from the order to «Готово», this week against the week before. */
export function prepTrendRule(input: InsightsInput): Candidate | null {
  if (input.business !== 'cafe') return null;
  const cfg = INSIGHT_RULES.prepTrend;
  const cur = prepTimes(input, input.now - WEEK, input.now);
  const prev = prepTimes(input, input.now - 2 * WEEK, input.now - WEEK);
  if (cur.length < cfg.minOrders || prev.length < cfg.minOrders) return null;
  const a = median(cur.map((p) => p.ms));
  const b = median(prev.map((p) => p.ms));
  if (b <= 0) return null;
  const change = a / b - 1;
  if (Math.abs(change) < cfg.minChange || Math.abs(a - b) < cfg.minDiffMs) return null;
  const numbers = `Обычно заказ ждёт «Готово» ${formatInsightDuration(a)}, неделей раньше — ${formatInsightDuration(b)}.`;
  if (change > 0) {
    return candidate(
      {
        id: 'prep-trend',
        severity: 'warn',
        title: `Заказы стали готовить дольше: ${formatInsightDuration(a)} вместо ${formatInsightDuration(b)}`,
        detail: `${numbers} Проверьте, хватает ли людей за стойкой в часы пик и не тормозит ли оборудование.`,
      },
      change * 100,
    );
  }
  return candidate(
    {
      id: 'prep-trend',
      severity: 'good',
      title: `Заказы готовят быстрее: ${formatInsightDuration(a)} вместо ${formatInsightDuration(b)}`,
      detail: `${numbers} Гости ждут меньше — так держать.`,
    },
    -change * 100,
  );
}

/** Cafe: the hour of the day when guests wait longest. */
export function slowHourRule(input: InsightsInput): Candidate | null {
  if (input.business !== 'cafe') return null;
  const cfg = INSIGHT_RULES.slowHour;
  const all = prepTimes(input, input.now - INSIGHTS_WINDOW_DAYS * DAY, input.now);
  if (all.length < cfg.minOrders) return null;
  const overall = median(all.map((p) => p.ms));
  const byHour = new Map<number, number[]>();
  for (const p of all) {
    const h = Math.floor(zonedParts(p.at, input.timezone).minuteOfDay / 60);
    const list = byHour.get(h) ?? [];
    list.push(p.ms);
    byHour.set(h, list);
  }
  let worst: { h: number; ms: number; n: number } | null = null;
  for (const [h, list] of byHour) {
    if (list.length < cfg.minPerHour) continue;
    const m = median(list);
    if (!worst || m > worst.ms) worst = { h, ms: m, n: list.length };
  }
  if (!worst || overall <= 0) return null;
  if (worst.ms < overall * cfg.minRatio || worst.ms - overall < cfg.minDiffMs) return null;
  const span = Math.max(1, Math.ceil(Math.min(INSIGHTS_WINDOW_DAYS, (input.now - Math.min(...all.map((p) => p.at))) / DAY)));
  const perDay = Math.round((worst.n / span) * 10) / 10;
  return candidate(
    {
      id: 'slow-hour',
      severity: 'tip',
      title: `Дольше всего ждут с ${worst.h} до ${worst.h + 1} часов: ${formatInsightDuration(worst.ms)} вместо ${formatInsightDuration(overall)}`,
      detail: `В этот час в среднем ${num1(perDay)} ${plural(perDay, ['заказ', 'заказа', 'заказов'])} в день. Поставьте на этот час второго человека за стойку или готовьте заготовки заранее.`,
      action: { label: 'Сотрудники', route: '/staff' },
    },
    (worst.ms / overall) * 15,
  );
}

const DAYPARTS = [
  { from: 0, to: 6, every: 'по ночам', when: 'ночью', tariff: 'ночной' },
  { from: 6, to: 12, every: 'по утрам', when: 'утром', tariff: 'утренний' },
  { from: 12, to: 18, every: 'днём', when: 'днём', tariff: 'дневной' },
  { from: 18, to: 24, every: 'по вечерам', when: 'вечером', tariff: 'вечерний' },
] as const;

function daypartOf(minuteOfDay: number): number {
  return Math.min(3, Math.floor(minuteOfDay / 360));
}

/** Billiards: tables standing empty in one part of the day while the evening is busy → a tariff for those hours. */
export function tableIdleRule(input: InsightsInput): Candidate | null {
  if (input.business !== 'billiards') return null;
  const cfg = INSIGHT_RULES.tableIdle;
  const since = input.now - INSIGHTS_WINDOW_DAYS * DAY;
  const games = input.games.filter((g) => g.startedAt >= since && g.startedAt <= input.now);
  if (games.length < cfg.minGames || input.tables.length < cfg.minTables) return null;
  const span = Math.min(INSIGHTS_WINDOW_DAYS, (input.now - Math.min(...games.map((g) => g.startedAt))) / DAY);
  if (span < INSIGHTS_MIN_HISTORY_DAYS) return null;

  const index = new Map(input.tables.map((t, i) => [t.id, i]));
  const busy = input.tables.map(() => [0, 0, 0, 0]);
  const started = [0, 0, 0, 0];
  for (const g of games) {
    const ti = index.get(g.tableId);
    if (ti === undefined) continue;
    started[daypartOf(zonedParts(g.startedAt, input.timezone).minuteOfDay)]! += 1;
    // Walk the game across daypart boundaries (00, 06, 12, 18 local).
    let t = g.startedAt;
    const end = Math.min(g.stoppedAt ?? input.now, input.now);
    while (t < end) {
      const p = zonedParts(t, input.timezone);
      const part = daypartOf(p.minuteOfDay);
      const toBoundary = ((part + 1) * 360 - p.minuteOfDay) * MINUTE - p.second * 1000 - p.millisecond;
      const next = Math.min(end, t + Math.max(1000, toBoundary));
      busy[ti]![part]! += next - t;
      t = next;
    }
  }
  const capacity = span * 6 * HOUR;
  const occ = busy.map((row) => row.map((ms) => ms / capacity));
  const club = [0, 1, 2, 3].map((d) => sum(occ.map((row) => row[d]!)) / occ.length);
  const bestPart = club.indexOf(Math.max(...club));
  if (club[bestPart]! <= 0) return null;

  let pick: { d: number; idle: number[] } | null = null;
  for (let d = 0; d < 4; d++) {
    if (d === bestPart || started[d]! < cfg.minDaypartGames) continue;
    if (club[d]! > club[bestPart]! * cfg.maxDaypartShare) continue;
    const idle = input.tables.map((_, i) => i).filter((i) => occ[i]![d]! <= cfg.idleShare);
    if (idle.length === 0) continue;
    if (!pick || club[d]! < club[pick.d]!) pick = { d, idle };
  }
  if (!pick) return null;
  const part = DAYPARTS[pick.d]!;
  const best = DAYPARTS[bestPart]!;
  const allIdle = pick.idle.length === input.tables.length;
  const names = pick.idle.slice(0, 3).map((i) => input.tables[i]!.name);
  const subject = allIdle
    ? `Столы ${part.every} почти пустуют`
    : names.length === 1
      ? `${names[0]} пустует ${part.every}`
      : `${names.join(', ')}${pick.idle.length > 3 ? ' и другие' : ''} пустуют ${part.every}`;
  const occIdle = sum(pick.idle.map((i) => occ[i]![pick.d]!)) / pick.idle.length;
  return candidate(
    {
      id: 'table-idle',
      severity: 'tip',
      title: `${subject} — включите ${part.tariff} тариф`,
      detail:
        `С ${String(part.from).padStart(2, '0')} до ${String(part.to % 24).padStart(2, '0')} ${allIdle ? 'столы заняты' : names.length === 1 ? 'он занят' : 'они заняты'} ${pct(occIdle)} времени, а ${best.when} столы заняты ${pct(club[bestPart]!)}. ` +
        'Скидка на эти часы приведёт тех, кому неудобно вечером.',
      action: { label: 'Тарифы', route: '/settings?tab=tariffs' },
    },
    (1 - club[pick.d]! / club[bestPart]!) * 40,
  );
}

function gameMs(g: InsightsInput['games'][number], now: number): number {
  return Math.max(0, Math.min(g.stoppedAt ?? now, now) - g.startedAt);
}

/** Billiards: long games, but few paid upfront → offer «на 2 часа» packages. */
export function prepaidRule(input: InsightsInput): Candidate | null {
  if (input.business !== 'billiards') return null;
  const cfg = INSIGHT_RULES.prepaid;
  const since = input.now - INSIGHTS_WINDOW_DAYS * DAY;
  const games = input.games.filter((g) => g.startedAt >= since && g.stoppedAt !== null && g.stoppedAt <= input.now);
  if (games.length < cfg.minGames) return null;
  const share = games.filter((g) => g.prepaid).length / games.length;
  const avg = sum(games.map((g) => gameMs(g, input.now))) / games.length;
  if (share >= cfg.maxShare || avg < cfg.minAvgMs) return null;
  return candidate(
    {
      id: 'prepaid',
      severity: 'tip',
      title: `Предлагайте игру «на 2 часа» с оплатой сразу: так платят только за ${pctWhole(share)} игр`,
      detail: `Средняя игра — ${formatInsightDuration(avg)} (${games.length} ${plural(games.length, ['игра', 'игры', 'игр'])} ${periodWords(historyDays(input) || INSIGHTS_WINDOW_DAYS)}). Деньги сразу в кассе, меньше неоплаченных столов, а лампа сама мигнёт за 5 минут до конца.`,
    },
    (cfg.maxShare - share) * 100,
  );
}

/** Billiards: average game this week against the week before. */
export function gameLengthRule(input: InsightsInput): Candidate | null {
  if (input.business !== 'billiards') return null;
  const cfg = INSIGHT_RULES.gameLength;
  const done = input.games.filter((g) => g.stoppedAt !== null && g.stoppedAt <= input.now);
  const cur = done.filter((g) => g.startedAt > input.now - WEEK);
  const prev = done.filter((g) => g.startedAt > input.now - 2 * WEEK && g.startedAt <= input.now - WEEK);
  if (cur.length < cfg.minGames || prev.length < cfg.minGames) return null;
  const a = sum(cur.map((g) => gameMs(g, input.now))) / cur.length;
  const b = sum(prev.map((g) => gameMs(g, input.now))) / prev.length;
  if (b <= 0) return null;
  const change = a / b - 1;
  if (Math.abs(change) < cfg.minChange) return null;
  const numbers = `${cur.length} ${plural(cur.length, ['игра', 'игры', 'игр'])} за последние 7 дней, ${prev.length} — неделей раньше.`;
  if (change < 0) {
    return candidate(
      {
        id: 'game-length',
        severity: 'tip',
        title: `Игры стали короче: в среднем ${formatInsightDuration(a)} вместо ${formatInsightDuration(b)}`,
        detail: `${numbers} Спросите гостей, всё ли устраивает: цена часа, сукно, кии, музыка.`,
        action: { label: 'Тарифы', route: '/settings?tab=tariffs' },
      },
      -change * 60,
    );
  }
  return candidate(
    {
      id: 'game-length',
      severity: 'good',
      title: `Игры стали длиннее: в среднем ${formatInsightDuration(a)} вместо ${formatInsightDuration(b)}`,
      detail: `${numbers} Гости задерживаются — хороший момент предложить бар.`,
    },
    change * 60,
  );
}

/** Closed shifts where the counted cash did not match → warn. */
export function cashRule(input: InsightsInput): Candidate | null {
  const cfg = INSIGHT_RULES.cash;
  const unit = minorPerMajor(input.currency);
  const since = input.now - INSIGHTS_WINDOW_DAYS * DAY;
  const shifts = input.shifts.filter((s) => s.closedAt >= since && s.closedAt <= input.now);
  const off = shifts.filter((s) => Math.abs(s.difference) >= cfg.minMajor * unit).sort((a, b) => b.closedAt - a.closedAt);
  if (off.length === 0) return null;
  const big = off.some((s) => Math.abs(s.difference) >= cfg.bigMajor * unit);
  if (off.length < 2 && !big) return null;
  const short = off.filter((s) => s.difference < 0);
  const signed = (v: number) => (v < 0 ? `−${formatMoney(-v, input.currency)}` : `+${formatMoney(v, input.currency)}`);
  const list = off
    .slice(0, 3)
    .map((s) => `№${s.number} (${shortDate(workingDay(s.closedAt, input.timezone))}) ${signed(s.difference)}`)
    .join(', ');
  const of = `${off.length} ${plural(off.length, ['смена', 'смены', 'смен'])} из ${shifts.length}`;
  const total = sum(off.map((s) => s.difference));
  const title = short.length > 0 ? `Недостача в кассе: ${of} за 4 недели` : `Излишки в кассе: ${of} за 4 недели`;
  const advice =
    short.length > 0
      ? 'Пересчитывайте кассу вдвоём при передаче смены и записывайте каждое изъятие.'
      : 'Лишние деньги в кассе бывают, когда продажу не пробили или сдачу дали неверно — сверьте чеки этих смен.';
  return candidate(
    {
      id: 'cash',
      severity: 'warn',
      title,
      detail: `${list}${off.length > 3 ? ' и другие' : ''}. Всего ${signed(total)}. ${advice}`,
      action: { label: 'Смены и отчёты', route: '/checks' },
    },
    50 + off.length * 5,
  );
}

/** Cancelled orders (and games) this week well above the usual share → careful warning. */
export function voidsRule(input: InsightsInput): Candidate | null {
  const cfg = INSIGHT_RULES.voids;
  const cur = input.voids.filter((v) => v.at > input.now - WEEK && v.at <= input.now);
  const base = input.voids.filter((v) => v.at > input.now - INSIGHTS_WINDOW_DAYS * DAY && v.at <= input.now - WEEK);
  const cancelled = cur.filter((v) => v.cancelled).length;
  if (cur.length < cfg.minOrders || cancelled < cfg.minCancelled) return null;
  const share = cancelled / cur.length;
  if (share < cfg.minShare) return null;
  const baseShare = base.length >= cfg.minOrders ? base.filter((v) => v.cancelled).length / base.length : null;
  if (baseShare === null ? share < cfg.shareWithoutBaseline : share < baseShare * cfg.baselineFactor) return null;
  const what = input.business === 'cafe' ? 'заказов' : 'заказов и игр';
  return candidate(
    {
      id: 'voids',
      severity: 'warn',
      title: `Отмен стало больше: ${cancelled} из ${cur.length} ${what} за неделю`,
      detail:
        `Это ${pct(share)}${baseShare !== null ? `, обычно — ${pct(baseShare)}` : ''}. ` +
        'Чаще всего это ошибки при вводе, но так же выглядят и продажи мимо кассы. Посмотрите причины отмен и кто их оформлял.',
      action: { label: 'Журнал', route: '/journal' },
    },
    40 + share * 100,
  );
}

export const INSIGHT_RULE_FNS = [
  peakHoursRule,
  slowItemsRule,
  topSellerRule,
  avgCheckRule,
  revenueDayRule,
  prepTrendRule,
  slowHourRule,
  tableIdleRule,
  prepaidRule,
  gameLengthRule,
  cashRule,
  voidsRule,
] as const;

/**
 * All rules, strongest first, at most `limit` cards. Warnings come before tips,
 * tips before good news; inside a group, the stronger signal first. A rule that
 * throws on odd data is skipped: a hint is never worth breaking the report.
 */
export function buildInsights(input: InsightsInput, limit = INSIGHTS_MAX_CARDS): InsightCard[] {
  const found: Candidate[] = [];
  for (const rule of INSIGHT_RULE_FNS) {
    try {
      const c = rule(input);
      if (c) found.push(c);
    } catch {
      // skip
    }
  }
  return found
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id))
    .slice(0, limit)
    .map((c) => c.card);
}
