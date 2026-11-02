/**
 * «Купили»: a trial coffee shop paid TS for a term. The platform owner sets the date it is paid until (any day up to
 * TRIAL_PAID_MAX_DAYS ahead, at a price agreed with the client), optionally the amount and a note — both internal,
 * seen only in the platform cabinet, never sent to the café. The café becomes a paying client (status 'paid'):
 *
 *  - the café sees it like «Полная версия» — no countdown, no price; its terms carry the end so the license works;
 *  - a week before the end (TRIAL_PAID_REMIND_DAYS) only the platform owner is told (Telegram / push, a mark in
 *    «Клиенты → Купили»); the café sees nothing until the day after the paid date, then it is read-only with
 *    TRIAL_PAID_ENDED_MESSAGE;
 *  - «Продлить оплату» sets a new date (amount, note) and adds to the payment history; «Сделать постоянной» and
 *    «Завершить» work as for a trial;
 *  - a cloud café gets `active` until the end of the paid day (the Worker needs no new status);
 *  - a page from before 'paid' is told `active` with the same end (trialTermsForVersion).
 *
 *   platform  POST /platform/trials/:id/paid  TrialPaidRequest → TrialView («Купили», «Продлить оплату»)
 *
 * Pure types and rules shared by the cloud, the cabinet and the trial page.
 */
import { isBookingDay, shiftDay } from './booking.ts';
import type { TrialStatus, TrialTerms } from './trial.ts';
import { legacyTrialTerms, trialCalendarDay, trialDayEnd } from './trial.ts';

/** The paid date may be set this many days ahead at most (about three years). */
export const TRIAL_PAID_MAX_DAYS = 3 * 366;
/** The platform owner is told this many days before the paid term ends. */
export const TRIAL_PAID_REMIND_DAYS = 7;
/** Amounts in minor units (tiyn); a sum by agreement up to this. */
export const TRIAL_PAID_AMOUNT_MAX = 100_000_000_000;
export const TRIAL_PAID_NOTE_MAX = 500;

/** The terms' version of a page that knows 'paid' (`v=3`); `v=2` pages get it as 'active', older ones legacyTrialTerms. */
export const TRIAL_TERMS_PAID_VERSION = 3;

/** POST /platform/trials/:id/paid. */
export interface TrialPaidRequest {
  /** YYYY-MM-DD: paid through this day of the café's zone (today … today + TRIAL_PAID_MAX_DAYS). */
  until: string;
  /** The sum agreed with the client, minor units (tiyn); internal. */
  amount?: number | null;
  /** Internal note (who paid, how, what was agreed). */
  note?: string | null;
}

/** One payment in the history. */
export interface TrialPayment {
  at: number;
  until: string;
  amount: number | null;
  note: string | null;
  /** Who of the platform team entered it. */
  by: string;
}

/** TrialView.paid: the café bought TS (null for a trial that never did). Platform cabinet only. */
export interface TrialPaidView {
  /** Paid through this day (YYYY-MM-DD, the café's zone). */
  until: string;
  /** When it first bought. */
  since: number;
  /** The latest payment's amount and note. */
  amount: number | null;
  note: string | null;
  /** Every payment, newest first. */
  payments: TrialPayment[];
  /** When the platform owner was told the paid term ends soon (null: not yet in this term). */
  remindedAt: number | null;
}

/** The days «Оплачено до» may be: today … today + TRIAL_PAID_MAX_DAYS in the café's zone. */
export function trialPaidRange(now: number, timeZone: string): { min: string; max: string } {
  const today = trialCalendarDay(now, timeZone);
  return { min: today, max: shiftDay(today, TRIAL_PAID_MAX_DAYS) };
}

/** `date` as a valid paid date (YYYY-MM-DD within trialPaidRange), else null. */
export function trialPaidUntil(date: unknown, now: number, timeZone: string): string | null {
  if (!isBookingDay(date)) return null;
  const { min, max } = trialPaidRange(now, timeZone);
  return date >= min && date <= max ? date : null;
}

/** The paid term's last millisecond: the end of the paid day in the café's zone (the café works through it). */
export function trialPaidEndsAt(until: string, timeZone: string): number {
  return trialDayEnd(until, timeZone);
}

/** The amount as typed (₸, spaces and a comma allowed) → minor units; null when empty; undefined when it is not a sum. */
export function parsePaidAmount(text: string): number | null | undefined {
  const s = text.replace(/[\s  ₸]/g, '').replace(',', '.');
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const minor = Math.round(Number(s) * 100);
  return minor > 0 && minor <= TRIAL_PAID_AMOUNT_MAX ? minor : undefined;
}

/** A paid request's amount as the cloud takes it: a whole number of minor units, or null; undefined when wrong. */
export function paidAmountOf(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= TRIAL_PAID_AMOUNT_MAX ? v : undefined;
}

/** A paid request's note: trimmed, empty → null; undefined when too long or not text. */
export function paidNoteOf(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s.length > TRIAL_PAID_NOTE_MAX) return undefined;
  return s || null;
}

/** The statuses «Купили» is offered for: the café was approved (not a request). */
export function canMarkPaid(status: TrialStatus): boolean {
  return status !== 'pending' && status !== 'rejected';
}

/** Whole days of the paid term left (the paid day counts), 0 when it is over. */
export function paidDaysLeft(endsAt: number, now: number): number {
  if (endsAt <= now) return 0;
  return Math.max(1, Math.ceil((endsAt - now) / 86_400_000));
}

/** «Скоро конец оплаты»: a paid café whose term ends within TRIAL_PAID_REMIND_DAYS (and has not ended). */
export function paidEndsSoon(t: { status: TrialStatus; endsAt: number }, now: number): boolean {
  return t.status === 'paid' && t.endsAt > now && t.endsAt - now <= TRIAL_PAID_REMIND_DAYS * 86_400_000;
}

/**
 * The terms in the words of the page's version: `v=3` (TRIAL_TERMS_PAID_VERSION) and later — all of them; `v=2` —
 * 'paid' as 'active' with the same end (that page knows every other status); older — legacyTrialTerms.
 */
export function trialTermsForVersion(terms: TrialTerms, version: unknown, now: number): TrialTerms {
  const v = Number(version);
  if (v >= TRIAL_TERMS_PAID_VERSION) return terms;
  const plain: TrialTerms = terms.status === 'paid' ? { ...terms, status: 'active' } : terms;
  return v === 2 ? plain : legacyTrialTerms(plain, now);
}
