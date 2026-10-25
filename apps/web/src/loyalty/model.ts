import type {
  CheckLoyaltyView,
  CheckView,
  LoyaltyAdjustRequest,
  LoyaltyApplyRequest,
  LoyaltyGuestCard,
  LoyaltyGuestDetail,
  LoyaltyGuestsView,
  LoyaltyLookupView,
  LoyaltySettings,
  Minor,
} from '@bills/domain';
import { formatMoney, normalizeLoyaltySettings, stampProgress } from '@bills/domain';
import { command, fetchJson } from '../api.ts';

/** Loyalty settings from the hall state (an older HUB sends none: off). */
export const loyaltyOf = (settings: { loyalty?: Partial<LoyaltySettings> } | null | undefined): LoyaltySettings =>
  normalizeLoyaltySettings(settings?.loyalty ?? {});

// ── HUB calls ───────────────────────────────────────────────────────────────

export const lookupGuest = (phone: string) => fetchJson<LoyaltyLookupView>(`/api/loyalty/lookup?phone=${encodeURIComponent(phone)}`);

export const fetchCheckLoyalty = (checkId: string) => fetchJson<CheckLoyaltyView>(`/api/checks/${checkId}/loyalty`);

export const applyCheckLoyalty = (actor: string, checkId: string, body: LoyaltyApplyRequest) =>
  command<{ loyalty: CheckLoyaltyView; check: CheckView }>(`/api/checks/${checkId}/loyalty`, actor, body);

export const removeCheckLoyalty = (actor: string, checkId: string) =>
  command<{ loyalty: CheckLoyaltyView; check: CheckView }>(`/api/checks/${checkId}/loyalty/remove`, actor, {});

export const saveLoyaltySettings = (actor: string, patch: Partial<LoyaltySettings>) =>
  command<LoyaltySettings>('/api/loyalty/settings', actor, patch);

export const fetchGuests = (q: string) => fetchJson<LoyaltyGuestsView>(`/api/loyalty/guests?q=${encodeURIComponent(q)}&limit=200`);

export const fetchGuest = (id: string) => fetchJson<LoyaltyGuestDetail>(`/api/loyalty/guests/${id}`);

export const adjustGuest = (actor: string, id: string, body: LoyaltyAdjustRequest) =>
  command<LoyaltyGuestDetail>(`/api/loyalty/guests/${id}/adjust`, actor, body);

// ── Words ───────────────────────────────────────────────────────────────────

/** «+7 701 123 45 67» from up to ten typed digits, «_» for the missing ones. */
export function phoneMask(digits: string): string {
  const d = digits.padEnd(10, '_');
  return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;
}

/** What the guest has, in a few words: «3 из 6 до подарка» or «Бонусов: 450 ₸». */
export function guestStatus(card: LoyaltyGuestCard, settings: LoyaltySettings, currency: string): string {
  if (settings.program === 'stamps') {
    const p = stampProgress(card.stamps, settings.stampsEvery);
    return p.ready ? `${p.have} из ${p.of} · подарок готов` : `${p.have} из ${p.of} до подарка`;
  }
  return `Бонусов: ${formatMoney(card.bonus, currency)}`;
}

/** The chip on the counter: «Аня · 3 из 6» / «•• 45 67 · 450 ₸». */
export function guestChip(card: LoyaltyGuestCard, settings: LoyaltySettings, currency: string): string {
  const who = card.name ?? `•• ${card.phone.slice(-5)}`;
  if (settings.program === 'stamps') return `${who} · ${card.stamps} из ${settings.stampsEvery}`;
  return `${who} · ${formatMoney(card.bonus, currency)}`;
}

/** After payment: «+45 ₸ бонусов» / «Штампов: 4 из 6». */
export function earnedLine(view: CheckLoyaltyView | null | undefined, settings: LoyaltySettings, currency: string): string | null {
  if (!view?.accrued || !view.guest) return null;
  if (settings.program === 'stamps') {
    const stamps = view.guest.stamps;
    return `Гостю: ${stamps} из ${settings.stampsEvery}${view.applied.kind === 'FREE' ? ' · подарок выдан' : ''}`;
  }
  return view.accrued.bonus > 0 ? `Гостю начислено ${formatMoney(view.accrued.bonus, currency)} бонусами` : null;
}

/** «6-й кофе в подарок»: the ordinal of the gift. */
export const giftOrdinal = (every: number) => `${every}-й`;

export const minus = (a: Minor, currency: string) => `−${formatMoney(a, currency)}`;
