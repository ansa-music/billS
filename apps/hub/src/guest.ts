import { randomBytes, randomUUID } from 'node:crypto';
import type {
  BusinessType,
  CounterLineInput,
  CounterStage,
  CreateCounterOrderRequest,
  CreateCounterOrderResponse,
  CreateGuestRequest,
  GuestLinksResponse,
  GuestLinkView,
  GuestMenu,
  GuestPageView,
  GuestRequestKind,
  GuestRequestLine,
  GuestRequestsResponse,
  GuestRequestStatus,
  GuestRequestView,
  GuestTableView,
  OrderView,
  StaffGuestRequestView,
} from '@bills/domain';
import {
  decide,
  GUEST_NAME_MAX,
  GUEST_NOTE_MAX,
  GUEST_RATE,
  GUEST_RECENT_MS,
  GUEST_STOPPED_SHOWN_MS,
  GUEST_TOKEN_BYTES,
  guestRequestSummary,
  guestStageText,
  isGuestToken,
  priceAt,
  rateCheck,
  validateGuestRequest,
} from '@bills/domain';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { Hub } from './hub.ts';
import { record } from './journal.ts';
import { parseOptions, priceOrderLines } from './order-lines.ts';
import type { ProductRow } from './order-lines.ts';
import type { SessionRow } from './views.ts';
import { loadPauseSpans, loadSettings, orderItemsOf, ordersTotalOf, SESSION_SQL, toSessionView } from './views.ts';

/** Who the journal names for what guests do. */
export const GUEST_ACTOR = 'Гость (QR)';

interface LinkRow {
  id: string;
  club_id: string;
  table_id: string | null;
  token: string;
  created_at: number;
  rotated_at: number | null;
}

interface RequestRow {
  id: string;
  club_id: string;
  link_id: string;
  table_id: string | null;
  session_id: string | null;
  kind: GuestRequestKind;
  status: GuestRequestStatus;
  minutes: number | null;
  items: string;
  lines: string;
  total: number;
  guest_name: string | null;
  note: string | null;
  client_key: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  reject_reason: string | null;
  order_id: string | null;
  /** Joined. */
  table_name?: string | null;
  counter_number?: number | null;
  order_stage?: CounterStage | null;
  order_status?: string | null;
}

interface Club {
  id: string;
  name: string;
  timezone: string;
  currency: string;
}

const REQUEST_SQL = `
  SELECT r.*, t.name AS table_name, o.counter_number, o.stage AS order_stage, o.status AS order_status
  FROM guest_requests r
  LEFT JOIN billiard_tables t ON t.id = r.table_id
  LEFT JOIN bar_orders o ON o.id = r.order_id`;

const NOT_FOUND = () =>
  new HubError(404, 'GUEST_NOT_FOUND', 'Ссылка не работает — отсканируйте QR-код на столе ещё раз или позовите сотрудника');

function json<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function clean(raw: string | undefined | null, max: number): string | null {
  const t = (raw ?? '').trim().replace(/\s+/g, ' ');
  return t.length ? t.slice(0, max) : null;
}

export const newGuestToken = () => randomBytes(GUEST_TOKEN_BYTES).toString('base64url');

/**
 * «Страница гостя по QR» (packages/domain guest.ts). Guests reach it with the token of
 * their table's sticker (or the counter's) and only ever read their own table and create
 * requests; staff accept them — a bar request becomes an order through BarService, an
 * order ahead goes through CounterService with its payment — or reject them. The rate
 * limit lives in memory: a restart forgives, which is fine for a club LAN.
 */
export class GuestService {
  readonly #hub: Hub;
  readonly #hits = new Map<string, number[]>();

  constructor(hub: Hub) {
    this.#hub = hub;
  }

  // ── Settings and links (manager) ──────────────────────────────────────────

  enabled(): boolean {
    const club = this.#club();
    return one<{ enabled: number }>(this.#hub.db, 'SELECT enabled FROM guest_settings WHERE club_id = ?', club.id)?.enabled === 1;
  }

  setEnabled(enabled: boolean, actor: string): GuestLinksResponse {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    return transaction(db, () => {
      const club = this.#club();
      run(
        db,
        `INSERT INTO guest_settings (club_id, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (club_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        club.id,
        enabled ? 1 : 0,
        now,
        actor,
      );
      record(db, now, { actor, action: 'guest.settings', entityType: 'club', entityId: club.id, data: { enabled } });
      afterCommit(db, () => this.#hub.events.changed({ kind: 'guest' }));
      return this.links();
    });
  }

  /** The QR of every active table (billiards) or the counter (coffee shop); missing ones are made on the way. */
  links(): GuestLinksResponse {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    return transaction(db, () => {
      const club = this.#club();
      const business = this.#business(club.id);
      if (business === 'billiards') {
        const missing = all<{ id: string }>(
          db,
          `SELECT t.id FROM billiard_tables t
           WHERE t.club_id = ? AND t.is_active = 1 AND NOT EXISTS (SELECT 1 FROM guest_links l WHERE l.table_id = t.id)`,
          club.id,
        );
        for (const t of missing) {
          run(db, 'INSERT INTO guest_links (id, club_id, table_id, token, created_at) VALUES (?, ?, ?, ?, ?)', randomUUID(), club.id, t.id, newGuestToken(), now);
        }
      } else if (!one(db, 'SELECT id FROM guest_links WHERE club_id = ? AND table_id IS NULL', club.id)) {
        run(db, 'INSERT INTO guest_links (id, club_id, table_id, token, created_at) VALUES (?, ?, NULL, ?, ?)', randomUUID(), club.id, newGuestToken(), now);
      }
      const rows = all<LinkRow & { table_name: string | null }>(
        db,
        business === 'billiards'
          ? `SELECT l.*, t.name AS table_name FROM guest_links l JOIN billiard_tables t ON t.id = l.table_id
             WHERE l.club_id = ? AND t.is_active = 1 ORDER BY t.sort_order, t.name`
          : `SELECT l.*, NULL AS table_name FROM guest_links l WHERE l.club_id = ? AND l.table_id IS NULL`,
        club.id,
      );
      return {
        enabled: this.enabled(),
        business,
        links: rows.map((r): GuestLinkView => ({
          id: r.id,
          tableId: r.table_id,
          tableName: r.table_name,
          token: r.token,
          createdAt: r.created_at,
          rotatedAt: r.rotated_at,
        })),
      };
    });
  }

  /** A new token for one sticker: the old QR answers 404 from now on. */
  rotate(linkId: string, actor: string): GuestLinkView {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    return transaction(db, () => {
      const club = this.#club();
      const link = one<LinkRow>(db, 'SELECT * FROM guest_links WHERE id = ? AND club_id = ?', linkId, club.id);
      if (!link) throw new HubError(404, 'GUEST_LINK_NOT_FOUND', 'QR-код не найден');
      const token = newGuestToken();
      run(db, 'UPDATE guest_links SET token = ?, rotated_at = ? WHERE id = ?', token, now, link.id);
      record(db, now, {
        actor,
        action: 'guest.link_rotated',
        entityType: 'guest_link',
        entityId: link.id,
        data: { tableId: link.table_id },
      });
      afterCommit(db, () => this.#hub.events.changed({ kind: 'guest', ...(link.table_id ? { tableId: link.table_id } : {}) }));
      const tableName = link.table_id
        ? (one<{ name: string }>(db, 'SELECT name FROM billiard_tables WHERE id = ?', link.table_id)?.name ?? null)
        : null;
      return { id: link.id, tableId: link.table_id, tableName, token, createdAt: link.created_at, rotatedAt: now };
    });
  }

  // ── The guest page (public) ───────────────────────────────────────────────

  /** `mine` — ids of requests this phone sent (coffee shop: everyone shares one QR). */
  page(token: string, mine: readonly string[] = []): GuestPageView {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    const { link, club, business } = this.#resolve(token);
    const settings = loadSettings(db, club.id);
    const barOn = this.#allowed(business === 'cafe' ? 'counter.take' : 'order.create');
    const table = link.table_id ? this.#table(link.table_id, now) : null;

    let rows: RequestRow[];
    if (business === 'billiards') {
      const since = table?.session ? table.session.requestedAt : now - 30 * 60_000;
      rows = all<RequestRow>(db, `${REQUEST_SQL} WHERE r.link_id = ? AND r.created_at >= ? ORDER BY r.created_at DESC LIMIT 10`, link.id, since);
    } else {
      const ids = mine.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 10);
      rows = ids.length
        ? all<RequestRow>(
            db,
            `${REQUEST_SQL} WHERE r.link_id = ? AND r.created_at >= ? AND r.id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at DESC`,
            link.id,
            now - GUEST_RECENT_MS,
            JSON.stringify(ids),
          )
        : [];
    }

    const status = table?.view.status ?? 'FREE';
    const live = status === 'ACTIVE' || status === 'PAUSED' || status === 'OPENING';
    const can: GuestPageView['can'] =
      business === 'billiards'
        ? {
            WAITER: true,
            BAR: barOn && (status === 'ACTIVE' || status === 'PAUSED' || status === 'AWAITING_PAYMENT'),
            EXTEND: live && status !== 'OPENING',
            BILL: status !== 'FREE',
            PREORDER: false,
          }
        : { WAITER: false, BAR: false, EXTEND: false, BILL: false, PREORDER: barOn };

    return {
      business,
      venue: {
        title: settings.display.title ?? club.name,
        logoUrl: settings.display.logoUrl,
        currency: club.currency,
        timezone: club.timezone,
      },
      now,
      table: table?.view ?? null,
      menu: barOn ? this.#menu(club.id) : { categories: [], products: [] },
      can,
      requests: rows.map((r) => this.#toView(r)),
    };
  }

  createRequest(token: string, client: string, input: CreateGuestRequest): GuestRequestView {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    return transaction(db, () => {
      const { link, club, business } = this.#resolve(token);
      const problems = validateGuestRequest(input);
      if (problems.length) throw new HubError(422, 'GUEST_INVALID', problems.join('; '));

      const clientKey = typeof input.clientKey === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(input.clientKey) ? input.clientKey : null;
      if (clientKey) {
        const same = one<RequestRow>(db, `${REQUEST_SQL} WHERE r.link_id = ? AND r.client_key = ?`, link.id, clientKey);
        if (same) return this.#toView(same);
      }

      const page = this.page(token);
      if (!page.can[input.kind]) throw new HubError(409, 'GUEST_NOT_ALLOWED', this.#notAllowed(input.kind, business));
      const sessionId = link.table_id ? (this.#table(link.table_id, now)?.session?.id ?? null) : null;

      // One call for the waiter is enough: a second tap shows the same request.
      if (input.kind === 'WAITER' || input.kind === 'BILL' || input.kind === 'EXTEND') {
        const pending = one<RequestRow>(
          db,
          `${REQUEST_SQL} WHERE r.link_id = ? AND r.kind = ? AND r.status = 'PENDING' AND r.session_id IS ? ORDER BY r.created_at DESC LIMIT 1`,
          link.id,
          input.kind,
          sessionId,
        );
        if (pending) return this.#toView(pending);
      }

      const pendingCount =
        one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM guest_requests WHERE link_id = ? AND status = 'PENDING'", link.id)?.n ?? 0;
      const pendingMax = link.table_id ? GUEST_RATE.pendingPerTable : GUEST_RATE.pendingPerCounter;
      if (pendingCount >= pendingMax) {
        throw new HubError(429, 'GUEST_TOO_MANY', 'Запросов уже много — дождитесь сотрудника, к вам подойдут', { retryAfterMs: 60_000 });
      }
      this.#limit(link, client, now);

      let items: CounterLineInput[] = [];
      let lines: GuestRequestLine[] = [];
      let total = 0;
      if (input.kind === 'BAR' || input.kind === 'PREORDER') {
        items = (input.items ?? []).map((it) => ({
          productId: it.productId,
          qty: it.qty,
          ...(it.options?.length ? { options: [...it.options] } : {}),
        }));
        // Priced and checked against the menu and stock now; nothing is taken from stock until staff accept.
        const priced = priceOrderLines(db, club.id, items);
        lines = priced.map((l) => ({ title: l.title, qty: l.qty, amount: l.amount }));
        total = priced.reduce((s, l) => s + l.amount, 0);
      }
      const guestName = clean(input.guestName, GUEST_NAME_MAX);
      if (input.kind === 'PREORDER' && !guestName) throw new HubError(422, 'GUEST_NAME_REQUIRED', 'Напишите имя — по нему вас позовут');
      const note = clean(input.note, GUEST_NOTE_MAX);
      const minutes = input.kind === 'EXTEND' ? (input.minutes ?? null) : null;

      const id = randomUUID();
      run(
        db,
        `INSERT INTO guest_requests
           (id, club_id, link_id, table_id, session_id, kind, status, minutes, items, lines, total, guest_name, note, client_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        club.id,
        link.id,
        link.table_id,
        sessionId,
        input.kind,
        minutes,
        JSON.stringify(items),
        JSON.stringify(lines),
        total,
        guestName,
        note,
        clientKey,
        now,
      );
      record(db, now, {
        actor: GUEST_ACTOR,
        action: 'guest.request_created',
        entityType: 'guest_request',
        entityId: id,
        data: { kind: input.kind, tableId: link.table_id, sessionId, minutes, total, guestName, items: lines },
      });
      afterCommit(db, () => this.#hub.events.changed({ kind: 'guest', ...(link.table_id ? { tableId: link.table_id } : {}) }));
      return this.#toView(this.#row(id));
    });
  }

  // ── Staff side ────────────────────────────────────────────────────────────

  list(): GuestRequestsResponse {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    const club = this.#club();
    const pending = all<RequestRow>(db, `${REQUEST_SQL} WHERE r.club_id = ? AND r.status = 'PENDING' ORDER BY r.created_at, r.rowid`, club.id);
    const done = all<RequestRow>(
      db,
      `${REQUEST_SQL} WHERE r.club_id = ? AND r.status <> 'PENDING' AND r.resolved_at >= ? ORDER BY r.resolved_at DESC LIMIT 20`,
      club.id,
      now - GUEST_RECENT_MS,
    );
    return { enabled: this.enabled(), requests: [...pending, ...done].map((r) => this.#toStaffView(r)) };
  }

  /** For the route's permission check: a bar request needs `order.create`, an order ahead `counter.take`. */
  kindOf(requestId: string): GuestRequestKind {
    return this.#row(requestId).kind;
  }

  /**
   * Accepts a request. A bar request becomes an order on the game through the bar service,
   * with the employee as the author; an order ahead is taken on the counter instead
   * (counterOrder). The rest is an acknowledgement: the guest sees «Принято».
   */
  accept(requestId: string, actor: string): { request: StaffGuestRequestView; order: OrderView | null } {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    return transaction(db, () => {
      const row = this.#pending(requestId);
      if (row.kind === 'PREORDER') {
        throw new HubError(409, 'GUEST_PREORDER', 'Заказ гостя принимается на кассе: нажмите на него и оплатите как обычно');
      }
      let order: OrderView | null = null;
      if (row.kind === 'BAR') {
        if (!row.session_id) throw new HubError(409, 'GUEST_NO_GAME', 'У запроса нет игры — оформите заказ вручную');
        order = this.#hub.bar.createOrder({
          sessionId: row.session_id,
          items: json<CounterLineInput[]>(row.items, []),
          note: ['По QR', row.note].filter(Boolean).join(': '),
          actor,
        });
      }
      this.#resolveRow(row, 'ACCEPTED', actor, now, { orderId: order?.id ?? null });
      return { request: this.#toStaffView(this.#row(row.id)), order };
    });
  }

  reject(requestId: string, reason: string | undefined, actor: string): StaffGuestRequestView {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    return transaction(db, () => {
      const row = this.#pending(requestId);
      this.#resolveRow(row, 'REJECTED', actor, now, { reason: clean(reason, 200) });
      return this.#toStaffView(this.#row(row.id));
    });
  }

  /**
   * The cashier loaded an order ahead into «Касса» and takes it as usual: the counter
   * order (with its payment) and the request's link to it are one transaction, so the
   * guest's page shows the number at once, and a refused payment leaves the request pending.
   */
  counterOrder(
    requestId: string,
    body: CreateCounterOrderRequest,
    actor: string,
  ): CreateCounterOrderResponse & { request: StaffGuestRequestView } {
    const db = this.#hub.db;
    const now = this.#hub.clock.now();
    return transaction(db, () => {
      const row = this.#pending(requestId);
      if (row.kind !== 'PREORDER') throw new HubError(409, 'GUEST_NOT_PREORDER', 'Это не заказ гостя к стойке');
      const res = this.#hub.counter.create({ ...body, actor });
      this.#resolveRow(row, 'ACCEPTED', actor, now, { orderId: res.order.id, counterNumber: res.order.number });
      afterCommit(db, () => this.#hub.events.changed({ kind: 'counter' }));
      return { ...res, request: this.#toStaffView(this.#row(row.id)) };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  #club(): Club {
    const club = one<Club>(
      this.#hub.db,
      'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1',
    );
    if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
    return club;
  }

  #business(clubId: string): BusinessType {
    return loadSettings(this.#hub.db, clubId).business.type;
  }

  #allowed(action: 'order.create' | 'counter.take'): boolean {
    return decide(['manager'], action, this.#hub.license.gate()) === 'ok';
  }

  /** Off, malformed, unknown, rotated, a table removed or a sticker of the other kind of venue → 404. */
  #resolve(token: string): { link: LinkRow; club: Club; business: BusinessType } {
    const db = this.#hub.db;
    const club = this.#club();
    if (!this.enabled()) {
      throw new HubError(404, 'GUEST_OFF', 'Заказ по QR сейчас выключен — позовите сотрудника');
    }
    if (!isGuestToken(token)) throw NOT_FOUND();
    const link = one<LinkRow>(db, 'SELECT * FROM guest_links WHERE token = ? AND club_id = ?', token, club.id);
    if (!link) throw NOT_FOUND();
    const business = this.#business(club.id);
    if (business === 'billiards') {
      if (!link.table_id || !one(db, 'SELECT id FROM billiard_tables WHERE id = ? AND is_active = 1', link.table_id)) throw NOT_FOUND();
    } else if (link.table_id) {
      throw NOT_FOUND();
    }
    return { link, club, business };
  }

  /** The live game of the table, or one stopped a few minutes ago and not paid yet. */
  #table(tableId: string, now: number): { view: GuestTableView; session: { id: string; requestedAt: number } | null } | null {
    const db = this.#hub.db;
    const table = one<{ name: string }>(db, 'SELECT name FROM billiard_tables WHERE id = ?', tableId);
    if (!table) return null;
    const row =
      one<SessionRow>(db, `${SESSION_SQL} WHERE s.table_id = ? AND s.status IN ('OPENING', 'ACTIVE')`, tableId) ??
      one<SessionRow>(
        db,
        `${SESSION_SQL} WHERE s.table_id = ? AND s.status = 'AWAITING_PAYMENT' AND s.stopped_at >= ? ORDER BY s.stopped_at DESC LIMIT 1`,
        tableId,
        now - GUEST_STOPPED_SHOWN_MS,
      );
    if (!row) {
      return {
        view: {
          name: table.name,
          status: 'FREE',
          startedAt: null,
          stoppedAt: null,
          playedSeconds: null,
          amount: null,
          tariffName: null,
          priceLabel: null,
          pricePerHour: null,
          prepaid: null,
          orders: [],
          ordersTotal: 0,
          total: 0,
        },
        session: null,
      };
    }
    const s = toSessionView(row, loadPauseSpans(db, row.id), now, ordersTotalOf(db, row.id));
    const status = s.status as GuestTableView['status'];
    const rate = status === 'ACTIVE' || status === 'PAUSED' || status === 'OPENING' ? priceAt(now, s.tariff, s.timezone) : null;
    const orderRows = all<{ id: string; created_at: number; total: number }>(
      db,
      "SELECT id, created_at, total FROM bar_orders WHERE session_id = ? AND status <> 'CANCELLED' ORDER BY created_at",
      row.id,
    );
    const items = orderItemsOf(
      db,
      orderRows.map((o) => o.id),
    );
    const prepaid = s.prepaid
      ? { minutes: s.prepaid.minutes, until: s.prepaid.until, leftMs: s.prepaid.until === null ? null : Math.max(0, s.prepaid.until - now) }
      : null;
    const timeDue = s.prepaid?.checkId ? 0 : (s.amount ?? 0);
    return {
      view: {
        name: table.name,
        status,
        startedAt: s.startedAt,
        stoppedAt: s.stoppedAt,
        playedSeconds: s.playedSeconds,
        amount: s.amount,
        tariffName: s.tariffName,
        priceLabel: rate?.label ?? null,
        pricePerHour: rate?.pricePerHour ?? null,
        prepaid,
        orders: orderRows.map((o) => ({
          id: o.id,
          createdAt: o.created_at,
          items: (items.get(o.id) ?? []).map((it) => ({ title: it.title, qty: it.qty, amount: it.amount })),
          total: o.total,
        })),
        ordersTotal: s.ordersTotal,
        total: timeDue + s.ordersTotal,
      },
      session: { id: s.id, requestedAt: s.requestedAt },
    };
  }

  /** What the guest may pick: active products in active categories, not sold out. */
  #menu(clubId: string): GuestMenu {
    const db = this.#hub.db;
    const categories = all<{ id: string; name: string }>(
      db,
      'SELECT id, name FROM product_categories WHERE club_id = ? AND is_active = 1 ORDER BY sort_order, name',
      clubId,
    );
    const products = all<ProductRow>(
      db,
      `SELECT p.* FROM products p JOIN product_categories c ON c.id = p.category_id
       WHERE p.club_id = ? AND p.is_active = 1 AND c.is_active = 1 AND (p.stock IS NULL OR p.stock > 0)
       ORDER BY c.sort_order, p.sort_order, p.name`,
      clubId,
    );
    return {
      categories: categories.filter((c) => products.some((p) => p.category_id === c.id)),
      products: products.map((p) => ({ id: p.id, categoryId: p.category_id, name: p.name, price: p.price, options: parseOptions(p.options) })),
    };
  }

  #notAllowed(kind: GuestRequestKind, business: BusinessType): string {
    if (business === 'cafe') return 'Здесь можно только заказать заранее';
    switch (kind) {
      case 'BAR':
        return 'Заказ из бара — когда идёт игра. Позовите официанта';
      case 'EXTEND':
        return 'Продлить можно только идущую игру';
      case 'BILL':
        return 'На столе нет игры';
      default:
        return 'Этот запрос сейчас недоступен';
    }
  }

  /** Per phone (token + address) and per token, sliding window; 429 with the wait. */
  #limit(link: LinkRow, client: string, now: number): void {
    if (this.#hits.size > 5000) {
      for (const [key, hits] of this.#hits) if (!hits.some((t) => t > now - GUEST_RATE.windowMs)) this.#hits.delete(key);
    }
    const perToken = link.table_id ? GUEST_RATE.perTable : GUEST_RATE.perCounter;
    const keys: Array<[string, number]> = [
      [`c:${link.id}:${client}`, GUEST_RATE.perClient],
      [`t:${link.id}`, perToken],
    ];
    const checks = keys.map(([key, max]) => ({ key, r: rateCheck(this.#hits.get(key) ?? [], now, GUEST_RATE.windowMs, max) }));
    const refused = checks.filter((c) => !c.r.allowed);
    if (refused.length) {
      const retryAfterMs = Math.max(...refused.map((c) => c.r.retryAfterMs));
      throw new HubError(429, 'GUEST_RATE_LIMIT', `Слишком много запросов — попробуйте через ${Math.ceil(retryAfterMs / 60_000)} мин или позовите сотрудника`, {
        retryAfterMs,
      });
    }
    for (const c of checks) this.#hits.set(c.key, c.r.hits);
  }

  #row(id: string): RequestRow {
    const club = this.#club();
    const row = one<RequestRow>(this.#hub.db, `${REQUEST_SQL} WHERE r.id = ? AND r.club_id = ?`, id, club.id);
    if (!row) throw new HubError(404, 'GUEST_REQUEST_NOT_FOUND', 'Запрос гостя не найден');
    return row;
  }

  #pending(id: string): RequestRow {
    const row = this.#row(id);
    if (row.status !== 'PENDING') {
      throw new HubError(409, 'GUEST_REQUEST_DONE', row.status === 'ACCEPTED' ? 'Запрос уже принят' : 'Запрос уже отклонён');
    }
    return row;
  }

  #resolveRow(
    row: RequestRow,
    status: 'ACCEPTED' | 'REJECTED',
    actor: string,
    now: number,
    extra: { orderId?: string | null; reason?: string | null; counterNumber?: number },
  ): void {
    const db = this.#hub.db;
    run(
      db,
      `UPDATE guest_requests SET status = ?, resolved_at = ?, resolved_by = ?, order_id = ?, reject_reason = ? WHERE id = ? AND status = 'PENDING'`,
      status,
      now,
      actor,
      extra.orderId ?? null,
      extra.reason ?? null,
      row.id,
    );
    record(db, now, {
      actor,
      action: status === 'ACCEPTED' ? 'guest.request_accepted' : 'guest.request_rejected',
      entityType: 'guest_request',
      entityId: row.id,
      data: {
        kind: row.kind,
        tableId: row.table_id,
        sessionId: row.session_id,
        minutes: row.minutes,
        guestName: row.guest_name,
        orderId: extra.orderId ?? null,
        ...(extra.counterNumber ? { counterNumber: extra.counterNumber } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
    });
    afterCommit(db, () => this.#hub.events.changed({ kind: 'guest', ...(row.table_id ? { tableId: row.table_id } : {}) }));
  }

  #toView(r: RequestRow): GuestRequestView {
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      minutes: r.minutes,
      guestName: r.guest_name,
      items: json<GuestRequestLine[]>(r.lines, []),
      total: r.total,
      order:
        r.kind === 'PREORDER' && r.counter_number != null && r.order_stage
          ? {
              number: r.counter_number,
              stage: r.order_stage,
              cancelled: r.order_status === 'CANCELLED',
              stageText: guestStageText(r.order_stage, r.order_status === 'CANCELLED'),
            }
          : null,
    };
  }

  #toStaffView(r: RequestRow): StaffGuestRequestView {
    const view = this.#toView(r);
    const lines = json<CounterLineInput[]>(r.items, []);
    return {
      ...view,
      tableId: r.table_id,
      tableName: r.table_name ?? null,
      sessionId: r.session_id,
      note: r.note,
      summary: guestRequestSummary({
        kind: r.kind,
        minutes: r.minutes,
        itemCount: lines.reduce((s, l) => s + l.qty, 0),
        guestName: r.guest_name,
      }),
      resolvedBy: r.resolved_by,
      rejectReason: r.reject_reason,
      orderId: r.order_id,
      lines,
    };
  }
}

