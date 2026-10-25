import type { InsightsInput, InsightsView } from '@bills/domain';
import { buildInsights, forecastStock, historyDays, INSIGHTS_WINDOW_DAYS, STOCK_WINDOW_DAYS } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';
import { loadSettings } from './views.ts';

export interface InsightsServiceDeps {
  db: Db;
  clock: Clock;
}

const DAY = 24 * 60 * 60 * 1000;
/** The answer is reused this long: the rules read four weeks of data, a minute changes nothing. */
export const INSIGHTS_CACHE_MS = 60_000;

/**
 * «Умные подсказки» and the stock forecast (packages/domain insights.ts,
 * stock-forecast.ts): reads the last 28 days from the club's own tables and
 * hands them to the pure rules. Read-only, no migrations, works offline.
 */
export class InsightsService {
  readonly #db: Db;
  readonly #clock: Clock;
  #cache: { at: number; view: InsightsView } | null = null;

  constructor(deps: InsightsServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  /** Cached up to INSIGHTS_CACHE_MS (HUB clock). */
  view(): InsightsView {
    const now = this.#clock.now();
    const cached = this.#cache;
    if (cached && now >= cached.at && now - cached.at < INSIGHTS_CACHE_MS) return cached.view;
    const view = this.compute(now);
    this.#cache = { at: now, view };
    return view;
  }

  compute(now: number): InsightsView {
    const input = this.input(now);
    const cards = buildInsights(input);
    const stock = this.#stock(now, input);
    return { generatedAt: now, historyDays: Math.floor(historyDays(input)), cards, stock };
  }

  /** Everything the rules look at, for the last 28 days. */
  input(now: number): InsightsInput {
    const db = this.#db;
    const club = one<{ id: string; timezone: string; currency: string }>(
      db,
      'SELECT id, timezone, currency FROM clubs ORDER BY created_at LIMIT 1',
    );
    if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
    const business = loadSettings(db, club.id).business.type;
    const since = now - INSIGHTS_WINDOW_DAYS * DAY;

    const visits =
      business === 'cafe'
        ? all<{ at: number }>(
            db,
            `SELECT created_at AS at FROM bar_orders
             WHERE club_id = ? AND counter_number IS NOT NULL AND status <> 'CANCELLED' AND created_at >= ? AND created_at <= ?`,
            club.id,
            since,
            now,
          ).map((r) => r.at)
        : all<{ at: number }>(
            db,
            `SELECT started_at AS at FROM table_sessions
             WHERE club_id = ? AND started_at IS NOT NULL AND status NOT IN ('CANCELLED', 'FAILED')
               AND started_at >= ? AND started_at <= ?`,
            club.id,
            since,
            now,
          ).map((r) => r.at);

    const products = all<{ id: string; name: string; created_at: number; is_active: number; cat_active: number }>(
      db,
      `SELECT p.id, p.name, p.created_at, p.is_active, c.is_active AS cat_active
       FROM products p JOIN product_categories c ON c.id = p.category_id WHERE p.club_id = ?`,
      club.id,
    ).map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at, onMenu: p.is_active === 1 && p.cat_active === 1 }));

    const sales = all<{ product_id: string; title: string; qty: number; amount: number; at: number }>(
      db,
      `SELECT i.product_id, i.title, i.qty, i.amount, o.created_at AS at
       FROM bar_order_items i JOIN bar_orders o ON o.id = i.order_id
       WHERE o.club_id = ? AND o.status <> 'CANCELLED' AND o.created_at >= ? AND o.created_at <= ?`,
      club.id,
      since,
      now,
    ).map((s) => ({ productId: s.product_id, name: s.title, at: s.at, qty: s.qty, amount: s.amount }));

    const checks = all<{ at: number; amount: number | null }>(
      db,
      `SELECT c.closed_at AS at,
              (SELECT SUM(CASE WHEN p.kind = 'PAYMENT' THEN p.amount ELSE -p.amount END) FROM payments p WHERE p.check_id = c.id) AS amount
       FROM checks c WHERE c.club_id = ? AND c.status = 'PAID' AND c.closed_at >= ? AND c.closed_at <= ?`,
      club.id,
      since,
      now,
    )
      .map((c) => ({ at: c.at, amount: c.amount ?? 0 }))
      // A check paid back in full is not a sale.
      .filter((c) => c.amount > 0);

    const payments = all<{ at: number; amount: number }>(
      db,
      `SELECT at, CASE WHEN kind = 'PAYMENT' THEN amount ELSE -amount END AS amount
       FROM payments WHERE club_id = ? AND at >= ? AND at <= ?`,
      club.id,
      since,
      now,
    );

    const prep =
      business === 'cafe'
        ? all<{ at: number; ready_at: number }>(
            db,
            `SELECT created_at AS at, ready_at FROM bar_orders
             WHERE club_id = ? AND counter_number IS NOT NULL AND ready_at IS NOT NULL AND status <> 'CANCELLED'
               AND created_at >= ? AND created_at <= ?`,
            club.id,
            since,
            now,
          ).map((r) => ({ at: r.at, readyAt: r.ready_at }))
        : [];

    const games =
      business === 'billiards'
        ? all<{ table_id: string; started_at: number; stopped_at: number | null; prepaid: number }>(
            db,
            `SELECT s.table_id, s.started_at, s.stopped_at, (pg.session_id IS NOT NULL) AS prepaid
             FROM table_sessions s LEFT JOIN prepaid_games pg ON pg.session_id = s.id
             WHERE s.club_id = ? AND s.started_at IS NOT NULL AND s.status NOT IN ('CANCELLED', 'FAILED')
               AND s.started_at >= ? AND s.started_at <= ?`,
            club.id,
            since,
            now,
          ).map((g) => ({ tableId: g.table_id, startedAt: g.started_at, stoppedAt: g.stopped_at, prepaid: g.prepaid === 1 }))
        : [];

    const tables =
      business === 'billiards'
        ? all<{ id: string; name: string }>(
            db,
            'SELECT id, name FROM billiard_tables WHERE club_id = ? AND is_active = 1 ORDER BY sort_order, name',
            club.id,
          )
        : [];

    const shifts = all<{ number: number; closed_at: number; difference: number }>(
      db,
      `SELECT number, closed_at, difference FROM cash_shifts
       WHERE club_id = ? AND status = 'CLOSED' AND difference IS NOT NULL AND closed_at >= ? AND closed_at <= ?`,
      club.id,
      since,
      now,
    ).map((s) => ({ number: s.number, closedAt: s.closed_at, difference: s.difference }));

    // Orders taken (cancelled or not); in a billiard club also games that really started.
    const voids = all<{ at: number; cancelled: number }>(
      db,
      `SELECT created_at AS at, (status = 'CANCELLED') AS cancelled FROM bar_orders
       WHERE club_id = ? AND created_at >= ? AND created_at <= ?`,
      club.id,
      since,
      now,
    ).map((v) => ({ at: v.at, cancelled: v.cancelled === 1 }));
    if (business === 'billiards') {
      for (const g of all<{ at: number; cancelled: number }>(
        db,
        `SELECT started_at AS at, (status = 'CANCELLED') AS cancelled FROM table_sessions
         WHERE club_id = ? AND started_at IS NOT NULL AND status <> 'FAILED' AND started_at >= ? AND started_at <= ?`,
        club.id,
        since,
        now,
      )) {
        voids.push({ at: g.at, cancelled: g.cancelled === 1 });
      }
    }

    return {
      now,
      timezone: club.timezone,
      currency: club.currency,
      business,
      visits,
      products,
      sales,
      checks,
      payments,
      prep,
      games,
      tables,
      shifts,
      voids,
    };
  }

  #stock(now: number, input: InsightsInput): InsightsView['stock'] {
    const db = this.#db;
    const tracked = all<{ id: string; name: string; stock: number }>(
      db,
      `SELECT p.id, p.name, p.stock FROM products p JOIN product_categories c ON c.id = p.category_id
       WHERE p.club_id = (SELECT id FROM clubs ORDER BY created_at LIMIT 1)
         AND p.stock IS NOT NULL AND p.is_active = 1 AND c.is_active = 1
       ORDER BY c.sort_order, p.sort_order, p.name`,
    );
    if (tracked.length === 0) return [];
    const first = one<{ at: number | null }>(
      db,
      "SELECT MIN(created_at) AS at FROM bar_orders WHERE status <> 'CANCELLED' AND created_at <= ?",
      now,
    )?.at;
    const days = first == null ? 0 : Math.min(STOCK_WINDOW_DAYS, (now - first) / DAY);
    return forecastStock({
      now,
      timezone: input.timezone,
      products: tracked,
      sales: input.sales.filter((s) => s.at > now - STOCK_WINDOW_DAYS * DAY),
      historyDays: days,
    });
  }
}
