import type { Minor } from './money.ts';

/**
 * «Лояльность без приложения»: the guest is known by a phone number only, no app, no SMS.
 * Two programs, one at a time (club setting, manager edits):
 *  - cashback — N % of what the guest paid comes back as bonuses (1 bonus = 1 ₸, kept in
 *    minor units); bonuses pay up to `maxRedeemPercent` of a check and expire `expiryDays`
 *    after they were earned;
 *  - stamps — every N-th drink of the chosen categories is free.
 *
 * Accounting: a reward is a DISCOUNT on the check (reason «Лояльность»), never a payment
 * method — the cash drawer, X/Z reports and refunds see real money only. Bonuses are earned
 * when the check is fully paid and taken back when it is refunded.
 *
 * Pure rules here; the HUB keeps guests and a ledger of moves (apps/hub/src/loyalty.ts).
 */

export class LoyaltyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LoyaltyError';
    this.code = code;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

export const LOYALTY_PROGRAMS = ['cashback', 'stamps'] as const;
export type LoyaltyProgram = (typeof LOYALTY_PROGRAMS)[number];

export const LOYALTY_PROGRAM_LABEL: Record<LoyaltyProgram, string> = {
  cashback: 'Кэшбэк бонусами',
  stamps: 'Каждый N-й напиток в подарок',
};

export interface LoyaltySettings {
  /** Off by default: the counter shows no «Гость» chip until the manager switches it on. */
  enabled: boolean;
  program: LoyaltyProgram;
  /** cashback: whole percent of the paid amount, 1…50. */
  cashbackPercent: number;
  /** stamps: every N-th unit is free (N − 1 paid, then one in a gift), 2…20. */
  stampsEvery: number;
  /** stamps: product categories that count; empty = categories named «Кофе…». */
  stampCategoryIds: string[];
  /** cashback: bonuses pay at most this share of a check, 0…100 %. */
  maxRedeemPercent: number;
  /** cashback: bonuses burn this many days after they were earned; 0 = never. */
  expiryDays: number;
}

export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  enabled: false,
  program: 'cashback',
  cashbackPercent: 5,
  stampsEvery: 6,
  stampCategoryIds: [],
  maxRedeemPercent: 50,
  expiryDays: 180,
};

const intIn = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Complete loyalty settings from whatever is stored or sent; invalid values keep `base`. */
export function normalizeLoyaltySettings(input: unknown, base: LoyaltySettings = DEFAULT_LOYALTY_SETTINGS): LoyaltySettings {
  const src = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const ids = Array.isArray(src.stampCategoryIds)
    ? [...new Set(src.stampCategoryIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100))].slice(0, 50)
    : base.stampCategoryIds;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : base.enabled,
    program: (LOYALTY_PROGRAMS as readonly unknown[]).includes(src.program) ? (src.program as LoyaltyProgram) : base.program,
    cashbackPercent: intIn(src.cashbackPercent, base.cashbackPercent, 1, 50),
    stampsEvery: intIn(src.stampsEvery, base.stampsEvery, 2, 20),
    stampCategoryIds: ids,
    maxRedeemPercent: intIn(src.maxRedeemPercent, base.maxRedeemPercent, 0, 100),
    expiryDays: intIn(src.expiryDays, base.expiryDays, 0, 3650),
  };
}

/**
 * Categories whose items earn stamps: the chosen ones that still exist, or — when none is
 * chosen — every category whose name starts with «Кофе» (the default for a coffee shop).
 */
export function stampCategories(
  settings: Pick<LoyaltySettings, 'stampCategoryIds'>,
  categories: ReadonlyArray<{ id: string; name: string }>,
): Set<string> {
  const chosen = settings.stampCategoryIds.filter((id) => categories.some((c) => c.id === id));
  if (chosen.length) return new Set(chosen);
  return new Set(categories.filter((c) => /^\s*кофе/i.test(c.name)).map((c) => c.id));
}

// ── Phone ───────────────────────────────────────────────────────────────────

/**
 * A Kazakhstan / Russia number as +7XXXXXXXXXX, or null. Accepts what staff type:
 * the last 10 digits («701 123 45 67»), «8 701…», «+7 (701) 123-45-67».
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  let ten: string;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) ten = digits.slice(1);
  else return null;
  // Codes start with 3…9 (KZ mobile 70x/74x/77x, landlines 7xx; RU 3xx–9xx).
  if (!/^[3-9]/.test(ten)) return null;
  return `+7${ten}`;
}

/** «+7 701 123 45 67» (only the manager sees it like this). */
export function formatPhone(phone: string): string {
  const ten = phone.replace(/\D/g, '').slice(-10);
  if (ten.length !== 10) return phone;
  return `+7 ${ten.slice(0, 3)} ${ten.slice(3, 6)} ${ten.slice(6, 8)} ${ten.slice(8)}`;
}

/** «+7 ••• ••• 45 67»: what the counter, receipts and the journal show. */
export function maskPhone(phone: string): string {
  const ten = phone.replace(/\D/g, '').slice(-10);
  if (ten.length !== 10) return '•••';
  return `+7 ••• ••• ${ten.slice(6, 8)} ${ten.slice(8)}`;
}

// ── Bonuses: balance with expiry ────────────────────────────────────────────

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One change of a guest's bonuses: + earned or returned, − spent or taken back. */
export interface BonusMove {
  at: number;
  amount: Minor;
}

export interface BonusBalance {
  /** What the guest can spend now. Never negative. */
  balance: Minor;
  /** The next bonuses to burn, if they expire at all. */
  expiring: { amount: Minor; at: number } | null;
  /** Burnt so far. */
  expired: Minor;
}

/**
 * Bonuses as lots: each credit lives `expiryDays` from its time (0 = forever); a debit takes
 * the oldest living lot first. A debit larger than what is left (a refund after the bonuses
 * were spent) becomes a debt that the next credits pay off first.
 */
export function bonusBalance(moves: readonly BonusMove[], now: number, expiryDays: number): BonusBalance {
  const life = expiryDays > 0 ? expiryDays * DAY_MS : Infinity;
  const lots: Array<{ amount: Minor; until: number }> = [];
  let debt = 0;
  let expired = 0;
  const burn = (at: number) => {
    while (lots.length && lots[0]!.until <= at) expired += lots.shift()!.amount;
  };
  const sorted = [...moves].sort((a, b) => a.at - b.at || b.amount - a.amount);
  for (const m of sorted) {
    if (m.at > now) continue;
    burn(m.at);
    if (m.amount > 0) {
      const pay = Math.min(debt, m.amount);
      debt -= pay;
      if (m.amount - pay > 0) lots.push({ amount: m.amount - pay, until: m.at + life });
    } else if (m.amount < 0) {
      let need = -m.amount;
      while (need > 0 && lots.length) {
        const lot = lots[0]!;
        const take = Math.min(lot.amount, need);
        lot.amount -= take;
        need -= take;
        if (lot.amount === 0) lots.shift();
      }
      debt += need;
    }
  }
  burn(now);
  const left = lots.reduce((s, l) => s + l.amount, 0);
  const first = lots[0];
  return {
    balance: Math.max(0, left - debt),
    expiring: first && Number.isFinite(first.until) ? { amount: first.amount, at: first.until } : null,
    expired,
  };
}

// ── Cashback ────────────────────────────────────────────────────────────────

const floorTo = (amount: number, step: number) => (step > 1 ? Math.floor(amount / step) * step : Math.floor(amount));

/** Bonuses earned on `paid` minor units at `percent` %, rounded down to whole `step` (1 ₸). */
export function cashbackAccrual(paid: Minor, percent: number, step: Minor = 1): Minor {
  if (!(paid > 0) || !(percent > 0)) return 0;
  return floorTo((paid * percent) / 100, step);
}

/**
 * The most bonuses a check may take: its share limit and the guest's balance, whole `step`.
 * `subtotal` is the check before any discount.
 */
export function redeemLimit(input: { subtotal: Minor; balance: Minor; maxPercent: number; step?: Minor }): Minor {
  const step = input.step ?? 1;
  const byShare = floorTo((Math.max(0, input.subtotal) * input.maxPercent) / 100, step);
  return Math.max(0, Math.min(byShare, floorTo(Math.max(0, input.balance), step)));
}

/** Checks a requested redemption: a positive whole amount (step) within the limit. */
export function assertRedeem(amount: Minor, limit: Minor, step: Minor = 1): Minor {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new LoyaltyError('LOYALTY_REDEEM_INVALID', 'Сумма бонусов — положительное целое число');
  }
  if (step > 1 && amount % step !== 0) {
    throw new LoyaltyError('LOYALTY_REDEEM_INVALID', 'Бонусы списываются целыми тенге');
  }
  if (amount > limit) {
    throw new LoyaltyError('LOYALTY_REDEEM_LIMIT', 'Столько бонусов списать нельзя');
  }
  return amount;
}

// ── Stamps ──────────────────────────────────────────────────────────────────

export interface StampPlan {
  /** Free units this check gets (the cheapest qualifying ones). */
  free: number;
  /** Their prices: the discount is their sum. */
  freePrices: Minor[];
  discount: Minor;
  /** Stamps the paid qualifying units add. */
  earned: number;
  /** Stamps a gift takes (N − 1 each). */
  used: number;
  /** The guest's stamps after this check. */
  after: number;
}

/**
 * What a check does to a stamp card. `units` are the prices of the qualifying units on it
 * (a line of 3 cappuccinos is three units). Going through the units, a gift is due as soon
 * as the guest holds N − 1 stamps — so with 4 of 6 and three coffees, the 6th coffee (the
 * cheapest of the three) is free. With `applyFree` false every unit just earns a stamp.
 */
export function stampPlan(input: { stamps: number; every: number; units: readonly Minor[]; applyFree: boolean }): StampPlan {
  const need = Math.max(1, input.every - 1);
  const q = input.units.length;
  let s = Math.max(0, input.stamps);
  let free = 0;
  if (input.applyFree) {
    let remaining = q;
    while (remaining > 0) {
      if (s >= need) {
        free++;
        s -= need;
        remaining--;
      } else {
        const take = Math.min(remaining, need - s);
        s += take;
        remaining -= take;
      }
    }
  } else {
    s += q;
  }
  const freePrices = [...input.units].sort((a, b) => a - b).slice(0, free);
  return {
    free,
    freePrices,
    discount: freePrices.reduce((a, b) => a + b, 0),
    earned: q - free,
    used: free * need,
    after: s,
  };
}

/** «3 из 6»: the card as the counter shows it; `ready` — the next qualifying unit is free. */
export function stampProgress(stamps: number, every: number): { have: number; of: number; ready: boolean } {
  const need = Math.max(1, every - 1);
  return { have: Math.max(0, stamps), of: every, ready: stamps >= need };
}

// ── HTTP API (HUB) ──────────────────────────────────────────────────────────

/** A guest as the counter sees them: masked phone, what they have now. */
export interface LoyaltyGuestCard {
  /** null — a new number: the guest is created when this order is paid. */
  id: string | null;
  /** Masked «+7 ••• ••• 45 67»; full only in the manager's list. */
  phone: string;
  name: string | null;
  /** Bonuses available now (minus those held by other open checks), minor units. */
  bonus: Minor;
  /** Stamps available now (minus those held by other open checks). */
  stamps: number;
  visits: number;
  lastVisitAt: number | null;
  expiring: { amount: Minor; at: number } | null;
}

/** GET /api/loyalty/lookup?phone=… */
export interface LoyaltyLookupView {
  guest: LoyaltyGuestCard;
  /** false — this number has no paid orders yet. */
  known: boolean;
}

/** How loyalty is applied to a check (counter order or POST /api/checks/:id/loyalty). */
export interface LoyaltyApplyRequest {
  /** Any form normalizePhone accepts. */
  phone: string;
  /** A name for a new guest (or to fill an empty one). */
  name?: string;
  /** cashback: bonuses to spend, minor units, whole tenge. */
  redeem?: Minor;
  /** stamps: take the gift that is due. */
  free?: boolean;
  /** The discount the screen showed; when the HUB computes another, 409 LOYALTY_CHANGED. */
  expectDiscount?: Minor;
}

/** POST /api/checks/:id/loyalty: without `phone` the guest already on the check is kept (screens see it masked). */
export type CheckLoyaltyRequest = Omit<LoyaltyApplyRequest, 'phone'> & { phone?: string };

/** The loyalty side of a check. */
export interface CheckLoyaltyView {
  checkId: string;
  guest: LoyaltyGuestCard | null;
  known: boolean;
  /** What is on the check now. */
  applied: { kind: 'BONUS' | 'FREE' | null; discount: Minor; redeemBonus: Minor; freeUnits: number };
  /** What could be applied (for the buttons). */
  offer: { redeemMax: Minor; freeUnits: number; freeDiscount: Minor };
  /** After payment: what was earned. */
  accrued: { bonus: Minor; stamps: number } | null;
  status: 'OPEN' | 'PAID' | 'REVERSED' | null;
}

/** One row of the manager's «Гости». */
export interface LoyaltyGuestRow extends LoyaltyGuestCard {
  id: string;
  /** Full number: the manager's list only. */
  phoneFull: string;
  createdAt: number;
}

/** GET /api/loyalty/guests?q=4567 */
export interface LoyaltyGuestsView {
  guests: LoyaltyGuestRow[];
  total: number;
}

/** POST /api/loyalty/guests/:id/adjust — manager only, with a reason. */
export interface LoyaltyAdjustRequest {
  /** + / − bonuses, minor units. */
  bonus?: Minor;
  stamps?: number;
  name?: string | null;
  reason: string;
}

/** One move in a guest's history. */
export interface LoyaltyMoveView {
  at: number;
  kind: 'ACCRUE' | 'REDEEM' | 'REVERSE' | 'RETURN' | 'ADJUST';
  bonus: Minor;
  stamps: number;
  checkNumber: number | null;
  reason: string | null;
  actor: string;
}

/** GET /api/loyalty/guests/:id */
export interface LoyaltyGuestDetail {
  guest: LoyaltyGuestRow;
  moves: LoyaltyMoveView[];
}
