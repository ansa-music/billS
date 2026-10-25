import { randomUUID } from 'node:crypto';
import type {
  CounterBoardView,
  CounterOrdersView,
  CounterOrderView,
  CounterStage,
  CreateCounterOrderRequest,
  CreateCounterOrderResponse,
  PayResponse,
} from '@bills/domain';
import {
  CANCEL_REASON_MIN,
  canMoveStage,
  COUNTER_NUMBER_MAX,
  COUNTER_SERVICES,
  COUNTER_STAGE_LABEL,
  COUNTER_STAGES,
  GUEST_NAME_MAX,
  nextCounterNumber,
  ORDER_NOTE_MAX,
  orderTotal,
  workingDay,
} from '@bills/domain';
import { detachOrder, netPaidOn, voidCheckIfEmpty } from './check-orders.ts';
import type { CheckService } from './checks.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { applyLoyalty, checkLoyaltyView, dropLoyaltyDiscount } from './loyalty.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { guardCancel } from './guard.ts';
import { record } from './journal.ts';
import { auditLines, insertOrderLines, parseOptionNames, priceOrderLines, returnOrderStock } from './order-lines.ts';
import { addDays } from './reports.ts';
import { requireOpenShift } from './shifts.ts';
import type { OrderRow } from './views.ts';
import { loadCheck, loadSettings, orderItemsOf } from './views.ts';

export interface CounterServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
  checks: CheckService;
}

/** How many handed-over orders GET /api/counter/orders keeps at the end of the list. */
export const ISSUED_SHOWN = 20;

const COUNTER_SQL = 'SELECT * FROM bar_orders WHERE club_id = ? AND counter_number IS NOT NULL';

function cleanText(raw: string | undefined | null, max: number, code: string, what: string): string | null {
  const text = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (text.length > max) throw new HubError(422, code, `${what} — не длиннее ${max} символов`);
  return text.length ? text : null;
}

/**
 * Counter orders of a coffee shop (packages/domain cafe.ts): bar orders without a
 * game, with a number of the working day, a stage at the bar and a check of their
 * own. Taking an order — lines, stock, check and payment — is one transaction: a
 * refused payment leaves nothing behind. The HUB exposes it as `hub.counter`.
 */
export class CounterService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;
  readonly #checks: CheckService;

  constructor(deps: CounterServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#checks = deps.checks;
  }

  /**
   * Takes an order: prices the lines with their options, takes stock down, gives it the
   * next number of the working day, puts it on a new check and — with `payment` — pays
   * that check the way POST /api/checks/:id/pay does (open shift, card/QR not above the
   * due, change from cash). Fully paid → the order is CLOSED at once.
   */
  create(input: Omit<CreateCounterOrderRequest, 'payment'> & { payment?: CreateCounterOrderRequest['payment']; actor: string }): CreateCounterOrderResponse {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const club = this.#club();
      if (!(COUNTER_SERVICES as readonly string[]).includes(input.service)) {
        throw new HubError(422, 'SERVICE_INVALID', 'Укажите: здесь или с собой');
      }
      const guestName = cleanText(input.guestName, GUEST_NAME_MAX, 'GUEST_NAME_TOO_LONG', 'Имя гостя');
      const note = cleanText(input.note, ORDER_NOTE_MAX, 'NOTE_TOO_LONG', 'Комментарий');
      // Before anything is written: without a shift the payment would fail anyway (rule 12).
      if (input.payment) requireOpenShift(db, club.id);
      const lines = priceOrderLines(db, club.id, input.items);
      const total = orderTotal(lines);
      const day = workingDay(now, club.timezone);
      const number = this.#nextNumber(club.id, day);

      const id = randomUUID();
      run(
        db,
        `INSERT INTO bar_orders
           (id, club_id, session_id, table_id, status, note, total, created_at, created_by, updated_at,
            counter_number, service, stage, guest_name, business_day)
         VALUES (?, ?, NULL, NULL, 'OPEN', ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?)`,
        id,
        club.id,
        note,
        total,
        now,
        input.actor,
        now,
        number,
        input.service,
        guestName,
        day,
      );
      insertOrderLines(db, id, lines, now);
      record(db, now, {
        actor: input.actor,
        action: 'order.created',
        entityType: 'order',
        entityId: id,
        data: {
          counterNumber: number,
          service: input.service,
          guestName,
          businessDay: day,
          sessionId: null,
          tableId: null,
          total,
          note,
          items: auditLines(lines),
        },
      });

      const check = this.#checks.create({ sessionIds: [], orderIds: [id], actor: input.actor });
      // «Гость» on the counter: guest, gift or bonuses go on the check before it is paid (loyalty.ts).
      if (input.loyalty) applyLoyalty(db, { ...input.loyalty, checkId: check.id, actor: input.actor, now });
      let payment: PayResponse | null = null;
      if (input.payment) {
        payment = this.#checks.pay({ checkId: check.id, parts: input.payment.parts, actor: input.actor });
      }
      afterCommit(db, () => this.#events.changed({ kind: 'counter' }));
      return {
        order: this.get(id),
        check: payment ? payment.check : loadCheck(db, check.id),
        payment,
        loyalty: input.loyalty ? checkLoyaltyView(db, check.id, now) : null,
      };
    });
  }

  get(orderId: string): CounterOrderView {
    return this.#toViews([this.#row(orderId)])[0]!;
  }

  /**
   * Orders of the working day (and the day before, so nothing is lost at 06:00) not yet
   * handed over, oldest first — the barista's queue; then the last ISSUED_SHOWN handed
   * over today, newest first. Cancelled orders are left out.
   */
  list(): CounterOrdersView {
    const db = this.#db;
    const club = this.#club();
    const day = workingDay(this.#clock.now(), club.timezone);
    const active = all<OrderRow>(
      db,
      `${COUNTER_SQL} AND business_day IN (?, ?) AND stage <> 'ISSUED' AND status <> 'CANCELLED'
       ORDER BY created_at, rowid`,
      club.id,
      day,
      addDays(day, -1),
    );
    const issued = all<OrderRow>(
      db,
      `${COUNTER_SQL} AND business_day = ? AND stage = 'ISSUED' AND status <> 'CANCELLED'
       ORDER BY issued_at DESC, rowid DESC LIMIT ${ISSUED_SHOWN}`,
      club.id,
      day,
    );
    return { orders: this.#toViews([...active, ...issued]) };
  }

  /** The guest screen: numbers being made (NEW and PREPARING, oldest first) and ready ones (by readiness). */
  board(): CounterBoardView {
    const db = this.#db;
    const now = this.#clock.now();
    const club = this.#club();
    const day = workingDay(now, club.timezone);
    const rows = all<Pick<OrderRow, 'counter_number' | 'guest_name' | 'stage'>>(
      db,
      `SELECT counter_number, guest_name, stage FROM bar_orders
       WHERE club_id = ? AND counter_number IS NOT NULL AND business_day IN (?, ?)
         AND stage <> 'ISSUED' AND status <> 'CANCELLED'
       ORDER BY CASE WHEN stage = 'READY' THEN ready_at ELSE created_at END, rowid`,
      club.id,
      day,
      addDays(day, -1),
    );
    const entry = (r: (typeof rows)[number]) => ({ number: r.counter_number!, guestName: r.guest_name });
    const display = loadSettings(db, club.id).display;
    return {
      preparing: rows.filter((r) => r.stage !== 'READY').map(entry),
      ready: rows.filter((r) => r.stage === 'READY').map(entry),
      now,
      title: display.title ?? club.name,
      logoUrl: display.logoUrl,
      timezone: club.timezone,
    };
  }

  /** The barista moves an order: forward a step, back a step, or straight to ISSUED (canMoveStage). */
  stage(input: { orderId: string; stage: CounterStage; actor: string }): CounterOrderView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const order = this.#row(input.orderId);
      const from = order.stage!;
      const to = input.stage;
      if (!(COUNTER_STAGES as readonly string[]).includes(to)) {
        throw new HubError(422, 'STAGE_INVALID', 'Неизвестный этап заказа');
      }
      if (order.status === 'CANCELLED') throw new HubError(409, 'ORDER_CANCELLED', `Заказ ${order.counter_number} отменён`);
      if (!canMoveStage(from, to)) {
        const message =
          from === 'ISSUED'
            ? `Заказ ${order.counter_number} уже выдан`
            : from === to
              ? `Заказ ${order.counter_number} уже «${COUNTER_STAGE_LABEL[to]}»`
              : `Заказ ${order.counter_number}: нельзя из «${COUNTER_STAGE_LABEL[from]}» в «${COUNTER_STAGE_LABEL[to]}»`;
        throw new HubError(409, 'STAGE_NOT_ALLOWED', message);
      }
      // Ready time stays when the order is handed over; going back from READY clears it.
      const readyAt = to === 'READY' ? now : to === 'ISSUED' ? order.ready_at : null;
      const issuedAt = to === 'ISSUED' ? now : null;
      run(
        db,
        'UPDATE bar_orders SET stage = ?, ready_at = ?, issued_at = ?, updated_at = ? WHERE id = ?',
        to,
        readyAt,
        issuedAt,
        now,
        order.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'counter.stage',
        entityType: 'order',
        entityId: order.id,
        data: { counterNumber: order.counter_number, from, to, service: order.service, status: order.status },
      });
      afterCommit(db, () => this.#events.changed({ kind: 'counter' }));
      return this.get(order.id);
    });
  }

  /**
   * Cancels a counter order with a reason: tracked stock comes back; an unpaid check
   * loses the lines (an emptied one is VOID). Money on the check → 409 ORDER_PAID: the
   * refund comes first, in «Счета» with a manager's approval (rule 14).
   */
  cancel(input: { orderId: string; reason: string; actor: string }): CounterOrderView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const order = this.#row(input.orderId);
      const reason = (input.reason ?? '').trim();
      if (reason.length < CANCEL_REASON_MIN) throw new HubError(422, 'REASON_REQUIRED', 'Укажите причину');
      if (order.status === 'CANCELLED') throw new HubError(409, 'ORDER_NOT_OPEN', 'Заказ уже отменён');
      if (order.check_id && netPaidOn(db, order.check_id) > 0) {
        throw new HubError(409, 'ORDER_PAID', 'Заказ оплачен — сначала оформите возврат в «Счетах»');
      }
      returnOrderStock(db, order.id, now);
      run(
        db,
        `UPDATE bar_orders SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
         WHERE id = ?`,
        now,
        input.actor,
        reason,
        now,
        order.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'order.cancelled',
        entityType: 'order',
        entityId: order.id,
        data: {
          counterNumber: order.counter_number,
          sessionId: null,
          tableId: null,
          total: order.total,
          stage: order.stage,
          reason,
          checkId: order.check_id,
        },
      });
      guardCancel(db, now, input.actor);
      // A check paid and fully refunded keeps its lines as history; an open one lets the order go.
      if (order.check_id && order.status === 'OPEN') {
        dropLoyaltyDiscount(db, order.check_id, input.actor, now, 'order_cancelled');
        detachOrder(db, order.id, input.actor, now);
        if (!voidCheckIfEmpty(db, order.check_id, input.actor, now)) loadCheck(db, order.check_id);
        afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      }
      afterCommit(db, () => this.#events.changed({ kind: 'counter' }));
      return this.get(order.id);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  #club(): { id: string; name: string; timezone: string } {
    const club = one<{ id: string; name: string; timezone: string }>(
      this.#db,
      'SELECT id, name, timezone FROM clubs ORDER BY created_at LIMIT 1',
    );
    if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
    return club;
  }

  #row(orderId: string): OrderRow {
    const row = one<OrderRow>(this.#db, 'SELECT * FROM bar_orders WHERE id = ? AND counter_number IS NOT NULL', orderId);
    if (!row) throw new HubError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
    return row;
  }

  /**
   * The number after the last one taken this working day, skipping numbers still on the
   * guest screen (after 999 the count starts over). 409 when all of them are taken.
   */
  #nextNumber(club: string, day: string): number {
    const db = this.#db;
    const last = one<{ n: number }>(
      db,
      `SELECT counter_number AS n FROM bar_orders WHERE club_id = ? AND business_day = ? AND counter_number IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      club,
      day,
    )?.n;
    const live = new Set(
      all<{ n: number }>(
        db,
        `SELECT counter_number AS n FROM bar_orders
         WHERE club_id = ? AND business_day IN (?, ?) AND counter_number IS NOT NULL
           AND stage <> 'ISSUED' AND status <> 'CANCELLED'`,
        club,
        day,
        addDays(day, -1),
      ).map((r) => r.n),
    );
    let n = nextCounterNumber(last);
    for (let i = 0; i < COUNTER_NUMBER_MAX; i++, n = nextCounterNumber(n)) {
      if (!live.has(n)) return n;
    }
    throw new HubError(409, 'COUNTER_FULL', `Все номера 1–${COUNTER_NUMBER_MAX} заняты — выдайте готовые заказы`);
  }

  #toViews(rows: OrderRow[]): CounterOrderView[] {
    const lines = orderItemsOf(
      this.#db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      number: r.counter_number!,
      service: r.service!,
      stage: r.stage!,
      status: r.status,
      guestName: r.guest_name,
      note: r.note,
      items: (lines.get(r.id) ?? []).map((it) => ({
        id: it.id,
        productId: it.product_id,
        title: it.title,
        optionNames: parseOptionNames(it.option_names),
        unitPrice: it.price,
        qty: it.qty,
        amount: it.amount,
      })),
      total: r.total,
      createdAt: r.created_at,
      createdBy: r.created_by,
      readyAt: r.ready_at,
      issuedAt: r.issued_at,
      checkId: r.check_id,
    }));
  }
}
