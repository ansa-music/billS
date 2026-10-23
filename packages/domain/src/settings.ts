import type { BusinessType } from './cafe.ts';
import { BUSINESS_TYPES } from './cafe.ts';

/**
 * Club settings beyond name, time zone and currency: how the hall screen looks
 * and the club's house rules. Stored as JSON on the club row; always read
 * through `normalizeClubSettings` so missing keys get defaults.
 */

export const THEMES = ['auto', 'dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

export const CARD_SIZES = ['compact', 'normal', 'large'] as const;
export type CardSize = (typeof CARD_SIZES)[number];

export const WAITER_VIEWS = ['amount', 'time'] as const;
/** What a waiter sees on a running table: the running amount or only the time. */
export type WaiterView = (typeof WAITER_VIEWS)[number];

export const FREE_TABLE_RULES = ['immediately', 'after_payment'] as const;
/** When a stopped table becomes free again. */
export type FreeTableRule = (typeof FREE_TABLE_RULES)[number];

export interface DisplaySettings {
  /** Shown instead of the club name on the hall screen; null = club name. */
  title: string | null;
  /** http(s), data:image or site-relative URL of a logo; null = the "8" ball. */
  logoUrl: string | null;
  theme: Theme;
  cardSize: CardSize;
  waiterSees: WaiterView;
}

export interface RuleSettings {
  freeTableAfterStop: FreeTableRule;
  /** Defaults for new tariffs. */
  defaultFreeMinutes: number;
  defaultMinimumMinutes: number;
  defaultStepMinutes: number;
  /** Final amounts are rounded to a multiple of this many minor units. */
  defaultRoundingMinor: number;
}

export interface BusinessSettings {
  /** billiards — tables, time and lamps; cafe — counter orders, barista and guest screens. */
  type: BusinessType;
}

export interface ClubSettings {
  display: DisplaySettings;
  rules: RuleSettings;
  business: BusinessSettings;
}

export const DEFAULT_CLUB_SETTINGS: ClubSettings = {
  display: { title: null, logoUrl: null, theme: 'auto', cardSize: 'normal', waiterSees: 'amount' },
  rules: {
    freeTableAfterStop: 'immediately',
    defaultFreeMinutes: 3,
    defaultMinimumMinutes: 30,
    defaultStepMinutes: 1,
    defaultRoundingMinor: 1000,
  },
  business: { type: 'billiards' },
};

/** What a screen may send: any subset; null clears a nullable text. */
export interface ClubSettingsPatch {
  display?: Partial<DisplaySettings>;
  rules?: Partial<RuleSettings>;
  business?: Partial<BusinessSettings>;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().slice(0, max);
  return t.length ? t : null;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function validLogo(value: unknown): string | null {
  const t = text(value, 200_000);
  if (!t) return null;
  return /^(https?:\/\/|data:image\/|\/)/i.test(t) ? t : null;
}

/**
 * Builds complete settings from whatever is stored or sent: unknown keys are
 * dropped, missing or invalid values fall back to `base` (the defaults).
 */
export function normalizeClubSettings(input: unknown, base: ClubSettings = DEFAULT_CLUB_SETTINGS): ClubSettings {
  const src = obj(input);
  const d = obj(src.display);
  const r = obj(src.rules);
  const b = obj(src.business);
  const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k);
  return {
    display: {
      title: has(d, 'title') ? text(d.title, 60) : base.display.title,
      logoUrl: has(d, 'logoUrl') ? validLogo(d.logoUrl) : base.display.logoUrl,
      theme: pick(d.theme, THEMES, base.display.theme),
      cardSize: pick(d.cardSize, CARD_SIZES, base.display.cardSize),
      waiterSees: pick(d.waiterSees, WAITER_VIEWS, base.display.waiterSees),
    },
    rules: {
      freeTableAfterStop: pick(r.freeTableAfterStop, FREE_TABLE_RULES, base.rules.freeTableAfterStop),
      defaultFreeMinutes: int(r.defaultFreeMinutes, base.rules.defaultFreeMinutes, 0, 60),
      defaultMinimumMinutes: int(r.defaultMinimumMinutes, base.rules.defaultMinimumMinutes, 0, 24 * 60),
      defaultStepMinutes: int(r.defaultStepMinutes, base.rules.defaultStepMinutes, 1, 60),
      defaultRoundingMinor: int(r.defaultRoundingMinor, base.rules.defaultRoundingMinor, 1, 1_000_000),
    },
    business: { type: pick(b.type, BUSINESS_TYPES, base.business.type) },
  };
}

/** Problems a person should fix before saving (normalize already dropped garbage). */
export function validateClubSettings(s: ClubSettings): string[] {
  const errors: string[] = [];
  if (s.rules.defaultMinimumMinutes > 0 && s.rules.defaultMinimumMinutes < s.rules.defaultFreeMinutes) {
    errors.push('Минимальное время не может быть меньше бесплатных минут');
  }
  if (s.rules.defaultMinimumMinutes > 0 && s.rules.defaultStepMinutes > s.rules.defaultMinimumMinutes) {
    errors.push('Шаг округления больше минимального времени');
  }
  return errors;
}
