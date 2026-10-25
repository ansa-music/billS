import { randomUUID } from 'node:crypto';
import type {
  CheckLoyaltyRequest,
  CheckLoyaltyView,
  LoyaltyAdjustRequest,
  LoyaltyGuestCard,
  LoyaltyGuestDetail,
  LoyaltyGuestRow,
  LoyaltyGuestsView,
  LoyaltyLookupView,
  LoyaltyMoveView,
  LoyaltySettings,
} from '@bills/domain';
import {
  assertReason,
  assertRedeem,
  bonusBalance,
  cashbackAccrual,
  formatPhone,
  GUEST_NAME_MAX,
  LoyaltyError,
  maskPhone,
  minorPerMajor,
  normalizeClubSettings,
  normalizePhone,
  redeemLimit,
  stampCategories,
  stampPlan,
} from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import { clubId, loadCheck, loadSettings } from './views.ts';

/**
 * «Лояльность без приложения» on the HUB (rules: packages/domain loyalty.ts).
 *
 * The reward is the check's discount (AMOUNT, reason «Лояльность: …»): payments, the shift's
 * cash and X/Z stay real money, the discount is spread over time and bar like any other.
 * Spending is only held while the check is open (`loyalty_checks.redeem_*`); the moves are
 * written when the check is PAID, together with what the guest earns. A refund takes the
 * earnings back (in proportion for cashback; all of it, and gives the spent back, when the
 * check is refunded in full).
 *
 * Plain functions are hooks for CheckService / CounterService (inside their transactions);
 * LoyaltyService is what the HTTP routes call.
 */

const ROW = 'SELECT * FROM loyalty_checks WHERE check_id = ?';
const REASON_BONUS = 'Лояльность: оплата бонусами';
const REASON_FREE = 'Лояльность: напиток в подарок';

interface GuestRow {
  id: string;
  club_id: string;
  phone: string;
  name: string | null;
  visits: number;
  last_visit_at: number | null;
  created_at: number;
}

interface LoyaltyCheckRow {
  check_id: string;
  club_id: string;
  phone: string;
  name: string | null;
  guest_id: string | null;
  status: 'OPEN' | 'PAID' | 'REVERSED';
  kind: 'BONUS' | 'FREE' | null;
  discount: number;
  redeem_bonus: number;
  redeem_stamps: number;
  free_units: number;
  program: string | null;
  cashback_percent: number | null;
  accrued_bonus: number;
  accrued_stamps: number;
}

interface CheckHead {
  id: string;
  club_id: string;
  number: number;
  status: string;
  currency: string;
  discount_kind: string | null;
}

const asHub = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LoyaltyError) throw new HubError(422, e.code, e.message);
    throw e;
  }
};

function settingsOf(db: Db, club: string): LoyaltySettings {
  return loadSettings(db, club).loyalty;
}

function checkHead(db: Db, checkId: string): CheckHead {
  const row = one<CheckHead>(
    db,
    `SELECT c.id, c.club_id, c.number, c.status, cl.currency, c.discount_kind
     FROM checks c JOIN clubs cl ON cl.id = c.club_id WHERE c.id = ?`,
    checkId,
  );
  if (!row) throw new HubError(404, 'CHECK_NOT_FOUND', 'Счёт не найден');
  return row;
}

function cleanName(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, GUEST_NAME_MAX);
  return t.length ? t : null;
}

function guestByPhone(db: Db, club: string, phone: string): GuestRow | undefined {
  return one<GuestRow>(db, 'SELECT * FROM loyalty_guests WHERE club_id = ? AND phone = ?', club, phone);
}

/** What other open checks of this number hold back (spending is final only when paid). */
function held(db: Db, club: string, phone: string, exceptCheck: string | null): { bonus: number; stamps: number } {
  const r = one<{ b: number | null; s: number | null }>(
    db,
    `SELECT SUM(lc.redeem_bonus) AS b, SUM(lc.redeem_stamps) AS s
     FROM loyalty_checks lc JOIN checks c ON c.id = lc.check_id
     WHERE lc.club_id = ? AND lc.phone = ? AND lc.status = 'OPEN' AND c.status = 'OPEN' AND lc.check_id IS NOT ?`,
    club,
    phone,
    exceptCheck,
  );
  return { bonus: r?.b ?? 0, stamps: r?.s ?? 0 };
}

function balances(db: Db, guestId: string, now: number, expiryDays: number) {
  const moves = all<{ at: number; bonus: number; stamps: number }>(
    db,
    'SELECT at, bonus, stamps FROM loyalty_moves WHERE guest_id = ? ORDER BY at, rowid',
    guestId,
  );
  const b = bonusBalance(
    moves.filter((m) => m.bonus !== 0).map((m) => ({ at: m.at, amount: m.bonus })),
    now,
    expiryDays,
  );
  return { bonus: b.balance, expiring: b.expiring, stamps: Math.max(0, moves.reduce((s, m) => s + m.stamps, 0)) };
}

/** The guest of a number as the counter sees them (masked), with what other open checks hold back. */
function cardOf(db: Db, club: string, phone: string, now: number, exceptCheck: string | null, name: string | null = null): { card: LoyaltyGuestCard; known: boolean } {
  const settings = settingsOf(db, club);
  const g = guestByPhone(db, club, phone);
  if (!g) {
    return {
      known: false,
      card: { id: null, phone: maskPhone(phone), name, bonus: 0, stamps: 0, visits: 0, lastVisitAt: null, expiring: null },
    };
  }
  const bal = balances(db, g.id, now, settings.expiryDays);
  const h = held(db, club, phone, exceptCheck);
  return {
    known: true,
    card: {
      id: g.id,
      phone: maskPhone(phone),
      name: g.name,
      bonus: Math.max(0, bal.bonus - h.bonus),
      stamps: Math.max(0, bal.stamps - h.stamps),
      visits: g.visits,
      lastVisitAt: g.last_visit_at,
      expiring: bal.expiring,
    },
  };
}

/** Prices of the units on a check that earn stamps (one per cup: a line of 3 is three units). */
function stampUnits(db: Db, club: string, checkId: string, settings: LoyaltySettings): number[] {
  const cats = stampCategories(
    settings,
    all<{ id: string; name: string }>(db, 'SELECT id, name FROM product_categories WHERE club_id = ?', club),
  );
  if (cats.size === 0) return [];
  const lines = all<{ unit_price: number | null; amount: number; qty: number | null; category_id: string }>(
    db,
    `SELECT ci.unit_price, ci.amount, ci.qty, p.category_id
     FROM check_items ci
     JOIN bar_order_items oi ON oi.id = ci.order_item_id
     JOIN products p ON p.id = oi.product_id
     WHERE ci.check_id = ? AND ci.kind = 'ORDER'`,
    checkId,
  );
  const units: number[] = [];
  for (const l of lines) {
    if (!cats.has(l.category_id)) continue;
    const qty = l.qty ?? 1;
    const price = l.unit_price ?? Math.floor(l.amount / Math.max(1, qty));
    for (let i = 0; i < qty; i++) units.push(price);
  }
  return units;
}

function setCheckDiscount(db: Db, check: CheckHead, amount: number, reason: string, actor: string, now: number): void {
  run(
    db,
    `UPDATE checks SET discount_kind = 'AMOUNT', discount_value = ?, discount_reason = ?, discount_by = ?, updated_at = ?
     WHERE id = ?`,
    amount,
    reason,
    actor,
    now,
    check.id,
  );
  record(db, now, {
    actor,
    action: 'check.discount_set',
    entityType: 'check',
    entityId: check.id,
    data: { kind: 'AMOUNT', value: amount, amount, reason, loyalty: true },
  });
}

function clearCheckDiscount(db: Db, check: CheckHead, actor: string, now: number): void {
  run(
    db,
    `UPDATE checks SET discount_kind = NULL, discount_value = NULL, discount_reason = NULL, discount_by = NULL, updated_at = ?
     WHERE id = ?`,
    now,
    check.id,
  );
  record(db, now, { actor, action: 'check.discount_removed', entityType: 'check', entityId: check.id, data: { loyalty: true } });
}

function netPaid(db: Db, checkId: string): number {
  return (
    one<{ n: number | null }>(
      db,
      "SELECT SUM(CASE WHEN kind = 'PAYMENT' THEN amount ELSE -amount END) AS n FROM payments WHERE check_id = ?",
      checkId,
    )?.n ?? 0
  );
}

function addMove(
  db: Db,
  m: { club: string; guestId: string; checkId: string | null; kind: LoyaltyMoveView['kind']; bonus: number; stamps: number; reason: string | null; actor: string; now: number },
): void {
  if (m.bonus === 0 && m.stamps === 0) return;
  run(
    db,
    `INSERT INTO loyalty_moves (id, club_id, guest_id, check_id, kind, bonus, stamps, reason, at, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    m.club,
    m.guestId,
    m.checkId,
    m.kind,
    m.bonus,
    m.stamps,
    m.reason,
    m.now,
    m.actor,
  );
}

// ── Hooks for CheckService / CounterService (inside their transactions) ─────

/** The loyalty discount on an open check (0 when none). */
export function loyaltyDiscountOn(db: Db, checkId: string): number {
  return one<{ d: number }>(db, "SELECT discount AS d FROM loyalty_checks WHERE check_id = ? AND status = 'OPEN'", checkId)?.d ?? 0;
}

/**
 * Takes the loyalty discount off an open check, the guest stays attached. Called before the
 * check's lines shrink (a game or an order taken off, a counter order cancelled): the gift or
 * the bonus share may no longer fit, so the cashier applies it again. Returns true if it did.
 */
export function dropLoyaltyDiscount(db: Db, checkId: string, actor: string, now: number, why: string): boolean {
  const row = one<LoyaltyCheckRow>(db, `${ROW} AND status = 'OPEN'`, checkId);
  if (!row || row.discount === 0) return false;
  const check = checkHead(db, checkId);
  run(
    db,
    `UPDATE loyalty_checks SET kind = NULL, discount = 0, redeem_bonus = 0, redeem_stamps = 0, free_units = 0, updated_at = ?
     WHERE check_id = ?`,
    now,
    checkId,
  );
  clearCheckDiscount(db, check, actor, now);
  record(db, now, {
    actor,
    action: 'loyalty.discount_dropped',
    entityType: 'check',
    entityId: checkId,
    data: { number: check.number, phone: maskPhone(row.phone), discount: row.discount, why },
  });
  return true;
}

/**
 * The check is PAID: spending becomes final (REDEEM) and the guest earns (ACCRUE) — cashback
 * on what was paid in money, or a stamp per qualifying unit that was not a gift. A new number
 * becomes a guest here. Without loyalty switched on nothing is earned (a discount already given stays).
 */
export function accrueLoyalty(db: Db, checkId: string, actor: string, now: number): void {
  const row = one<LoyaltyCheckRow>(db, `${ROW} AND status = 'OPEN'`, checkId);
  if (!row) return;
  const check = loadCheck(db, checkId);
  const head = checkHead(db, checkId);
  const settings = settingsOf(db, row.club_id);
  let guest = guestByPhone(db, row.club_id, row.phone);
  if (!guest) {
    const id = randomUUID();
    run(
      db,
      `INSERT INTO loyalty_guests (id, club_id, phone, name, visits, created_at, created_by, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      id,
      row.club_id,
      row.phone,
      row.name,
      now,
      actor,
      now,
    );
    record(db, now, {
      actor,
      action: 'loyalty.guest_created',
      entityType: 'loyalty_guest',
      entityId: id,
      data: { phone: maskPhone(row.phone), name: row.name, checkId },
    });
    guest = guestByPhone(db, row.club_id, row.phone)!;
  }
  const reason = `Счёт №${head.number}`;
  addMove(db, { club: row.club_id, guestId: guest.id, checkId, kind: 'REDEEM', bonus: -row.redeem_bonus, stamps: -row.redeem_stamps, reason, actor, now });

  let bonus = 0;
  let stamps = 0;
  if (settings.enabled) {
    if (settings.program === 'cashback') bonus = cashbackAccrual(check.total, settings.cashbackPercent, minorPerMajor(head.currency));
    else stamps = Math.max(0, stampUnits(db, row.club_id, checkId, settings).length - row.free_units);
  }
  addMove(db, { club: row.club_id, guestId: guest.id, checkId, kind: 'ACCRUE', bonus, stamps, reason, actor, now });
  run(
    db,
    `UPDATE loyalty_guests SET visits = visits + 1, last_visit_at = ?, name = COALESCE(name, ?), updated_at = ? WHERE id = ?`,
    now,
    row.name,
    now,
    guest.id,
  );
  run(
    db,
    `UPDATE loyalty_checks SET status = 'PAID', guest_id = ?, program = ?, cashback_percent = ?, accrued_bonus = ?,
       accrued_stamps = ?, paid_at = ?, updated_at = ? WHERE check_id = ?`,
    guest.id,
    settings.enabled ? settings.program : null,
    settings.enabled && settings.program === 'cashback' ? settings.cashbackPercent : null,
    bonus,
    stamps,
    now,
    now,
    checkId,
  );
  record(db, now, {
    actor,
    action: 'loyalty.accrued',
    entityType: 'check',
    entityId: checkId,
    data: {
      number: head.number,
      guestId: guest.id,
      phone: maskPhone(row.phone),
      paid: check.total,
      discount: row.discount,
      redeemedBonus: row.redeem_bonus,
      redeemedStamps: row.redeem_stamps,
      bonus,
      stamps,
    },
  });
}

/**
 * After a refund: cashback shrinks to what is still paid; a check refunded in full takes back
 * everything it earned and gives back what it spent (the guest's visit is not counted).
 */
export function reverseLoyaltyOnRefund(db: Db, checkId: string, actor: string, now: number): void {
  const row = one<LoyaltyCheckRow>(db, `${ROW} AND status = 'PAID'`, checkId);
  if (!row || !row.guest_id) return;
  const head = checkHead(db, checkId);
  const net = netPaid(db, checkId);
  const reason = `Возврат по счёту №${head.number}`;
  if (net <= 0) {
    addMove(db, { club: row.club_id, guestId: row.guest_id, checkId, kind: 'REVERSE', bonus: -row.accrued_bonus, stamps: -row.accrued_stamps, reason, actor, now });
    addMove(db, { club: row.club_id, guestId: row.guest_id, checkId, kind: 'RETURN', bonus: row.redeem_bonus, stamps: row.redeem_stamps, reason, actor, now });
    run(db, 'UPDATE loyalty_guests SET visits = MAX(0, visits - 1), updated_at = ? WHERE id = ?', now, row.guest_id);
    run(
      db,
      "UPDATE loyalty_checks SET status = 'REVERSED', accrued_bonus = 0, accrued_stamps = 0, updated_at = ? WHERE check_id = ?",
      now,
      checkId,
    );
    record(db, now, {
      actor,
      action: 'loyalty.reversed',
      entityType: 'check',
      entityId: checkId,
      data: { number: head.number, guestId: row.guest_id, full: true, bonus: -row.accrued_bonus, stamps: -row.accrued_stamps, returnedBonus: row.redeem_bonus, returnedStamps: row.redeem_stamps },
    });
    return;
  }
  if (row.cashback_percent !== null && row.accrued_bonus > 0) {
    const target = cashbackAccrual(net, row.cashback_percent, minorPerMajor(head.currency));
    if (target < row.accrued_bonus) {
      const back = row.accrued_bonus - target;
      addMove(db, { club: row.club_id, guestId: row.guest_id, checkId, kind: 'REVERSE', bonus: -back, stamps: 0, reason, actor, now });
      run(db, 'UPDATE loyalty_checks SET accrued_bonus = ?, updated_at = ? WHERE check_id = ?', target, now, checkId);
      record(db, now, {
        actor,
        action: 'loyalty.reversed',
        entityType: 'check',
        entityId: checkId,
        data: { number: head.number, guestId: row.guest_id, full: false, bonus: -back, stamps: 0 },
      });
    }
  }
}

/**
 * Attaches a guest to an open check without money on it and applies the reward asked for:
 * bonuses (cashback, within the share limit and the balance) or the gift that is due
 * (stamps, the cheapest qualifying unit). Replaces what was applied before.
 */
export function applyLoyalty(db: Db, input: CheckLoyaltyRequest & { checkId: string; actor: string; now: number }): void {
  asHub(() => {
    const { actor, now } = input;
    const check = checkHead(db, input.checkId);
    const settings = settingsOf(db, check.club_id);
    if (!settings.enabled) throw new HubError(409, 'LOYALTY_OFF', 'Программа лояльности выключена в настройках');
    if (check.status !== 'OPEN') throw new HubError(409, 'CHECK_NOT_OPEN', `Счёт №${check.number} уже закрыт`);
    if (netPaid(db, check.id) !== 0) {
      throw new HubError(409, 'CHECK_HAS_PAYMENTS', `По счёту №${check.number} уже есть оплата — гостя нужно указать до оплаты`);
    }
    const before = one<LoyaltyCheckRow>(db, ROW, check.id);
    // Without a number the guest already on the check stays (screens only see it masked).
    const phone = input.phone === undefined ? (before?.phone ?? null) : normalizePhone(input.phone);
    if (!phone) throw new HubError(422, 'PHONE_INVALID', 'Номер телефона: 10 цифр после +7');
    const name = input.name === undefined && input.phone === undefined ? (before?.name ?? null) : cleanName(input.name);
    const manualDiscount = check.discount_kind !== null && !(before && before.discount > 0);

    const redeem = settings.program === 'cashback' && input.redeem ? input.redeem : 0;
    const wantsFree = settings.program === 'stamps' && input.free === true;
    if ((redeem > 0 || wantsFree) && manualDiscount) {
      throw new HubError(409, 'DISCOUNT_EXISTS', 'На счёте уже есть скидка — бонусы и подарок с ней не суммируются');
    }

    const { card } = cardOf(db, check.club_id, phone, now, check.id, name);
    const items = loadCheck(db, check.id);
    let kind: 'BONUS' | 'FREE' | null = null;
    let discount = 0;
    let redeemBonus = 0;
    let redeemStamps = 0;
    let freeUnits = 0;
    if (redeem > 0) {
      const step = minorPerMajor(check.currency);
      const limit = redeemLimit({ subtotal: items.subtotal, balance: card.bonus, maxPercent: settings.maxRedeemPercent, step });
      assertRedeem(redeem, limit, step);
      kind = 'BONUS';
      discount = redeem;
      redeemBonus = redeem;
    } else if (wantsFree) {
      const plan = stampPlan({ stamps: card.stamps, every: settings.stampsEvery, units: stampUnits(db, check.club_id, check.id, settings), applyFree: true });
      if (plan.free === 0 || plan.discount === 0) throw new HubError(409, 'LOYALTY_NO_GIFT', 'Подарок гостю пока не положен');
      kind = 'FREE';
      discount = plan.discount;
      redeemStamps = plan.used;
      freeUnits = plan.free;
    }
    if (input.expectDiscount !== undefined && input.expectDiscount !== discount) {
      throw new HubError(409, 'LOYALTY_CHANGED', 'Бонусы гостя изменились — проверьте сумму и оплатите ещё раз');
    }

    if (before) {
      run(
        db,
        `UPDATE loyalty_checks SET phone = ?, name = ?, guest_id = ?, kind = ?, discount = ?, redeem_bonus = ?, redeem_stamps = ?,
           free_units = ?, updated_at = ? WHERE check_id = ?`,
        phone,
        name,
        card.id,
        kind,
        discount,
        redeemBonus,
        redeemStamps,
        freeUnits,
        now,
        check.id,
      );
    } else {
      run(
        db,
        `INSERT INTO loyalty_checks
           (check_id, club_id, phone, name, guest_id, status, kind, discount, redeem_bonus, redeem_stamps, free_units,
            attached_at, attached_by, updated_at)
         VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)`,
        check.id,
        check.club_id,
        phone,
        name,
        card.id,
        kind,
        discount,
        redeemBonus,
        redeemStamps,
        freeUnits,
        now,
        actor,
        now,
      );
    }
    if (discount > 0) {
      if (discount > items.subtotal) throw new HubError(409, 'DISCOUNT_EXCEEDS_TOTAL', 'Скидка больше суммы счёта');
      setCheckDiscount(db, check, discount, kind === 'FREE' ? REASON_FREE : REASON_BONUS, actor, now);
    } else if (before && before.discount > 0) {
      clearCheckDiscount(db, check, actor, now);
    }
    record(db, now, {
      actor,
      action: 'loyalty.applied',
      entityType: 'check',
      entityId: check.id,
      data: { number: check.number, guestId: card.id, phone: maskPhone(phone), kind, discount, redeemBonus, redeemStamps, freeUnits },
    });
    loadCheck(db, check.id); // the discount must fit the check
  });
}

/** Takes the guest (and their reward) off an open check without money on it. */
export function detachLoyalty(db: Db, checkId: string, actor: string, now: number): void {
  const check = checkHead(db, checkId);
  const row = one<LoyaltyCheckRow>(db, `${ROW} AND status = 'OPEN'`, checkId);
  if (!row) return;
  if (check.status !== 'OPEN' || netPaid(db, checkId) !== 0) {
    throw new HubError(409, 'CHECK_HAS_PAYMENTS', `По счёту №${check.number} уже есть оплата`);
  }
  if (row.discount > 0) clearCheckDiscount(db, check, actor, now);
  run(db, 'DELETE FROM loyalty_checks WHERE check_id = ?', checkId);
  record(db, now, {
    actor,
    action: 'loyalty.detached',
    entityType: 'check',
    entityId: checkId,
    data: { number: check.number, phone: maskPhone(row.phone), discount: row.discount },
  });
}

/** The loyalty side of a check: guest, what is applied, what could be, what was earned. */
export function checkLoyaltyView(db: Db, checkId: string, now: number): CheckLoyaltyView {
  const check = checkHead(db, checkId);
  const row = one<LoyaltyCheckRow>(db, ROW, checkId);
  const empty: CheckLoyaltyView = {
    checkId,
    guest: null,
    known: false,
    applied: { kind: null, discount: 0, redeemBonus: 0, freeUnits: 0 },
    offer: { redeemMax: 0, freeUnits: 0, freeDiscount: 0 },
    accrued: null,
    status: null,
  };
  if (!row) return empty;
  const settings = settingsOf(db, check.club_id);
  const { card, known } = cardOf(db, check.club_id, row.phone, now, checkId, row.name);
  const view: CheckLoyaltyView = {
    ...empty,
    guest: card,
    known,
    status: row.status,
    applied: { kind: row.kind, discount: row.discount, redeemBonus: row.redeem_bonus, freeUnits: row.free_units },
    accrued: row.status === 'OPEN' ? null : { bonus: row.accrued_bonus, stamps: row.accrued_stamps },
  };
  if (row.status === 'OPEN' && check.status === 'OPEN' && settings.enabled) {
    const items = loadCheck(db, checkId);
    if (settings.program === 'cashback') {
      view.offer.redeemMax = redeemLimit({
        subtotal: items.subtotal,
        balance: card.bonus,
        maxPercent: settings.maxRedeemPercent,
        step: minorPerMajor(check.currency),
      });
    } else {
      const plan = stampPlan({ stamps: card.stamps, every: settings.stampsEvery, units: stampUnits(db, check.club_id, checkId, settings), applyFree: true });
      view.offer.freeUnits = plan.free;
      view.offer.freeDiscount = plan.discount;
    }
  }
  return view;
}

// ── Service for the HTTP routes ─────────────────────────────────────────────

export interface LoyaltyServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

export class LoyaltyService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;

  constructor(deps: LoyaltyServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
  }

  settings(): LoyaltySettings {
    return settingsOf(this.#db, clubId(this.#db));
  }

  /** Saves the loyalty block of the club settings (the rest stays as it is). */
  saveSettings(input: { patch: Partial<LoyaltySettings>; actor: string }): LoyaltySettings {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const current = loadSettings(db, club);
      const next = normalizeClubSettings({ loyalty: input.patch }, current);
      if (JSON.stringify(next.loyalty) !== JSON.stringify(current.loyalty)) {
        run(db, 'UPDATE clubs SET settings = ? WHERE id = ?', JSON.stringify(next), club);
        record(db, now, {
          actor: input.actor,
          action: 'club.updated',
          entityType: 'club',
          entityId: club,
          data: { settings: { loyalty: next.loyalty } },
        });
        afterCommit(db, () => this.#events.changed({ kind: 'club' }));
      }
      return next.loyalty;
    });
  }

  /** The counter's «Гость»: a number → who it is and what they have. */
  lookup(rawPhone: string): LoyaltyLookupView {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new HubError(422, 'PHONE_INVALID', 'Номер телефона: 10 цифр после +7');
    const { card, known } = cardOf(this.#db, clubId(this.#db), phone, this.#clock.now(), null);
    return { guest: card, known };
  }

  check(checkId: string): CheckLoyaltyView {
    return checkLoyaltyView(this.#db, checkId, this.#clock.now());
  }

  apply(input: CheckLoyaltyRequest & { checkId: string; actor: string }): { loyalty: CheckLoyaltyView; check: ReturnType<typeof loadCheck> } {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      applyLoyalty(db, { ...input, now });
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return { loyalty: checkLoyaltyView(db, input.checkId, now), check: loadCheck(db, input.checkId) };
    });
  }

  detach(input: { checkId: string; actor: string }): { loyalty: CheckLoyaltyView; check: ReturnType<typeof loadCheck> } {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      detachLoyalty(db, input.checkId, input.actor, now);
      afterCommit(db, () => this.#events.changed({ kind: 'check' }));
      return { loyalty: checkLoyaltyView(db, input.checkId, now), check: loadCheck(db, input.checkId) };
    });
  }

  /** The manager's «Гости»: newest visit first; `q` — last digits of the number or part of the name. */
  guests(q: string | undefined, limit = 100): LoyaltyGuestsView {
    const db = this.#db;
    const club = clubId(db);
    const text = (q ?? '').trim();
    const digits = text.replace(/\D/g, '');
    let where = 'club_id = ?';
    const params: (string | number)[] = [club];
    if (digits.length > 0 && digits.length === text.replace(/[\s()+-]/g, '').length) {
      where += ' AND phone LIKE ?';
      params.push(`%${digits.slice(-10)}`);
    } else if (text) {
      where += ' AND name LIKE ?';
      params.push(`%${text}%`);
    }
    const total = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM loyalty_guests WHERE ${where}`, ...params)?.n ?? 0;
    const rows = all<GuestRow>(
      db,
      `SELECT * FROM loyalty_guests WHERE ${where} ORDER BY COALESCE(last_visit_at, created_at) DESC, rowid DESC LIMIT ?`,
      ...params,
      Math.min(500, Math.max(1, limit)),
    );
    return { guests: rows.map((g) => this.#row(g)), total };
  }

  guest(guestId: string): LoyaltyGuestDetail {
    const db = this.#db;
    const g = this.#guest(guestId);
    const moves = all<{ at: number; kind: LoyaltyMoveView['kind']; bonus: number; stamps: number; number: number | null; reason: string | null; actor: string }>(
      db,
      `SELECT m.at, m.kind, m.bonus, m.stamps, c.number, m.reason, m.actor
       FROM loyalty_moves m LEFT JOIN checks c ON c.id = m.check_id
       WHERE m.guest_id = ? ORDER BY m.at DESC, m.rowid DESC LIMIT 200`,
      g.id,
    );
    return {
      guest: this.#row(g),
      moves: moves.map((m) => ({ at: m.at, kind: m.kind, bonus: m.bonus, stamps: m.stamps, checkNumber: m.number, reason: m.reason, actor: m.actor })),
    };
  }

  /** Manager: + / − bonuses or stamps with a reason, or a name. Never below zero. */
  adjust(input: LoyaltyAdjustRequest & { guestId: string; actor: string }): LoyaltyGuestDetail {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const g = this.#guest(input.guestId);
      const bonus = input.bonus ?? 0;
      const stamps = input.stamps ?? 0;
      if (!Number.isInteger(bonus) || !Number.isInteger(stamps)) {
        throw new HubError(422, 'ADJUST_INVALID', 'Бонусы и штампы — целые числа');
      }
      const changesName = input.name !== undefined && cleanName(input.name) !== g.name;
      if (bonus === 0 && stamps === 0 && !changesName) throw new HubError(422, 'ADJUST_EMPTY', 'Нечего менять');
      if (bonus !== 0 || stamps !== 0) {
        const reason = assertReason(input.reason, 'причину');
        const card = cardOf(db, g.club_id, g.phone, now, null).card;
        if (card.bonus + bonus < 0) throw new HubError(422, 'ADJUST_BELOW_ZERO', 'Бонусов меньше, чем вы хотите списать');
        if (card.stamps + stamps < 0) throw new HubError(422, 'ADJUST_BELOW_ZERO', 'Штампов меньше, чем вы хотите списать');
        addMove(db, { club: g.club_id, guestId: g.id, checkId: null, kind: 'ADJUST', bonus, stamps, reason, actor: input.actor, now });
        record(db, now, {
          actor: input.actor,
          action: 'loyalty.adjusted',
          entityType: 'loyalty_guest',
          entityId: g.id,
          data: { phone: maskPhone(g.phone), bonus, stamps, reason },
        });
      }
      if (changesName) {
        const name = cleanName(input.name);
        run(db, 'UPDATE loyalty_guests SET name = ?, updated_at = ? WHERE id = ?', name, now, g.id);
        record(db, now, {
          actor: input.actor,
          action: 'loyalty.guest_renamed',
          entityType: 'loyalty_guest',
          entityId: g.id,
          data: { phone: maskPhone(g.phone), name },
        });
      }
      return this.guest(g.id);
    });
  }

  #guest(id: string): GuestRow {
    const g = one<GuestRow>(this.#db, 'SELECT * FROM loyalty_guests WHERE id = ? AND club_id = ?', id, clubId(this.#db));
    if (!g) throw new HubError(404, 'GUEST_NOT_FOUND', 'Гость не найден');
    return g;
  }

  #row(g: GuestRow): LoyaltyGuestRow {
    const { card } = cardOf(this.#db, g.club_id, g.phone, this.#clock.now(), null);
    return { ...card, id: g.id, phoneFull: formatPhone(g.phone), createdAt: g.created_at };
  }
}
