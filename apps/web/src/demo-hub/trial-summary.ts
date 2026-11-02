/**
 * «Смотреть с телефона»: the owner's summary the browser coffee shop sends with its report
 * (trial-cloud.ts) and the cabinet's phone page shows (#/v/<token>). Revenue comes from the HUB's
 * own owner summary (apps/hub/src/reports.ts, ReportService.summary — called, never changed): today,
 * and its 14-day chart read three times back gives 7 and 30 days. What a coffee shop needs on top —
 * paid checks, best sellers and money by payment method today — are small read-only queries.
 */
import type { OwnerSummary, TrialSummary } from '@bills/domain';
import { TRIAL_SUMMARY_TOP } from '@bills/domain';
import { addDays, localMidnightUtc } from '@ts-hub/reports.ts';
import type { DatabaseSync } from './shims/sqlite.ts';

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

export interface SummarySource {
  summary(date?: string): OwnerSummary;
}

/** The owner's summary now; null when the club is not set up yet. */
export function collectSummary(reports: SummarySource, db: DatabaseSync, now = Date.now()): TrialSummary | null {
  let today: OwnerSummary;
  try {
    today = reports.summary();
  } catch {
    return null;
  }
  const tz = today.timezone;
  const date = today.date;
  // revenueByDay: 14 days ending at the given date, oldest first.
  const byDay = new Map<string, number>(today.revenueByDay.map((p) => [p.date, p.amount]));
  for (const back of [14, 28]) {
    for (const p of reports.summary(addDays(date, -back)).revenueByDay) if (!byDay.has(p.date)) byDay.set(p.date, p.amount);
  }
  const sumDays = (n: number): number => {
    let total = 0;
    for (let i = 0; i < n; i++) total += byDay.get(addDays(date, -i)) ?? 0;
    return total;
  };
  const days: TrialSummary['days'] = [];
  for (let i = 6; i >= 0; i--) {
    const day = addDays(date, -i);
    days.push({ day, revenue: byDay.get(day) ?? 0 });
  }

  const from = localMidnightUtc(date, tz);
  const to = localMidnightUtc(addDays(date, 1), tz);
  const one = (sql: string, ...params: unknown[]): Row => db.prepare(sql).get(...params) ?? {};
  const all = (sql: string, ...params: unknown[]): Row[] => db.prepare(sql).all(...params);

  const checksToday = num(one("SELECT COUNT(*) AS n FROM checks WHERE status = 'PAID' AND closed_at >= ? AND closed_at < ?", from, to).n);
  const topToday = all(
    `SELECT i.title AS name, SUM(i.qty) AS qty, SUM(i.amount) AS revenue
     FROM bar_order_items i JOIN bar_orders o ON o.id = i.order_id
     WHERE o.status <> 'CANCELLED' AND o.created_at >= ? AND o.created_at < ?
     GROUP BY i.title ORDER BY qty DESC, revenue DESC, i.title LIMIT ?`,
    from,
    to,
    TRIAL_SUMMARY_TOP,
  ).map((r) => ({ name: String(r.name ?? '').slice(0, 120), qty: num(r.qty), revenue: num(r.revenue) }));
  const methodsToday = { cash: 0, card: 0, qr: 0 };
  for (const r of all(
    "SELECT method, SUM(CASE kind WHEN 'REFUND' THEN -amount ELSE amount END) AS amount FROM payments WHERE at >= ? AND at < ? GROUP BY method",
    from,
    to,
  )) {
    const key = String(r.method).toLowerCase();
    if (key === 'cash' || key === 'card' || key === 'qr') methodsToday[key] = num(r.amount);
  }
  const last = one('SELECT MAX(at) AS at FROM (SELECT MAX(created_at) AS at FROM bar_orders UNION ALL SELECT MAX(at) AS at FROM payments)').at;
  const revenueToday = today.revenue.today;
  return {
    at: now,
    currency: today.currency,
    timezone: tz,
    date,
    revenueToday,
    revenue7: sumDays(7),
    revenue30: sumDays(30),
    checksToday,
    avgCheckToday: checksToday > 0 ? Math.round(revenueToday / checksToday) : 0,
    topToday,
    methodsToday,
    shiftOpen: num(one("SELECT COUNT(*) AS n FROM cash_shifts WHERE status = 'OPEN'").n) > 0,
    lastActivityAt: last === null || last === undefined ? null : num(last),
    days,
  };
}
