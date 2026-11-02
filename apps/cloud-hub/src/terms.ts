/**
 * The terms of a cloud café instead of a signed license: TS sets them through the admin API
 * (`PUT /admin/cafes/<code>/terms`), the café's Durable Object keeps them in its own storage and the HUB's license
 * gate is built from them (Hub `license.terms`, apps/hub/src/license.ts) — no signing key lives in the Worker.
 *
 *   active     until `endsAt` (then read-only by itself, like an expired license)
 *   permanent  no end
 *   ended      read-only now, with TS's message
 *
 * Free of Cloudflare imports so Node tests can run it.
 */
import type { LicensePayload, LicenseStatus } from '@bills/domain';
import { licenseStatus, TRIAL_PERMANENT_LICENSE_UNTIL } from '@bills/domain';
import { CloudError } from './errors.ts';

export const TERMS_STATUSES = ['active', 'ended', 'permanent'] as const;
export type CafeTermsStatus = (typeof TERMS_STATUSES)[number];

export interface CafeTerms {
  status: CafeTermsStatus;
  /** Epoch ms: when an active café turns read-only (exclusive); for `ended`, when it ended; null for permanent. */
  endsAt: number | null;
  /** TS's words for the café owner, shown in read-only mode; null — the standard text. */
  message: string | null;
  /** When TS set these terms. */
  setAt: number;
}

/** What `PUT /admin/cafes/<code>/terms` (and the optional `terms` of create and import) takes. */
export interface CafeTermsInput {
  status: CafeTermsStatus;
  endsAt: number | null;
  message?: string | null;
}

const DAY_MS = 86_400_000;
/** A new cloud café works this long unless TS says otherwise. */
export const NEW_CAFE_DAYS = 14;
const MESSAGE_MAX = 500;
/** Ends later than this are surely a mistake in units (seconds vs ms, or a year typo). */
const ENDS_MAX = TRIAL_PERMANENT_LICENSE_UNTIL;

export function defaultTerms(now: number): CafeTerms {
  return { status: 'active', endsAt: now + NEW_CAFE_DAYS * DAY_MS, message: null, setAt: now };
}

/** Validates terms from TS. Throws 400 with a plain reason. */
export function parseTerms(input: unknown, now: number): CafeTerms {
  const bad = (why: string) => new CloudError(400, 'TERMS_INVALID', why);
  if (!input || typeof input !== 'object') throw bad('Нужны условия: {status, endsAt, message?}');
  const v = input as Partial<Record<keyof CafeTermsInput, unknown>>;
  if (typeof v.status !== 'string' || !(TERMS_STATUSES as readonly string[]).includes(v.status)) {
    throw bad("status — 'active', 'ended' или 'permanent'");
  }
  const status = v.status as CafeTermsStatus;
  let endsAt: number | null = null;
  if (v.endsAt !== null && v.endsAt !== undefined) {
    if (typeof v.endsAt !== 'number' || !Number.isFinite(v.endsAt) || v.endsAt <= 0 || v.endsAt > ENDS_MAX) {
      throw bad('endsAt — время в миллисекундах или null');
    }
    endsAt = Math.floor(v.endsAt);
  }
  if (status === 'active' && endsAt === null) throw bad('Для active нужен endsAt — до какого времени работает касса');
  let message: string | null = null;
  if (v.message !== null && v.message !== undefined) {
    if (typeof v.message !== 'string') throw bad('message — строка или null');
    message = v.message.trim().slice(0, MESSAGE_MAX) || null;
  }
  return { status, endsAt: status === 'permanent' ? null : endsAt, message, setAt: now };
}

function dateRu(ms: number): string {
  const d = new Date(ms + 5 * 3_600_000);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

const ENDED_TEXT = 'Доступ к облачной кассе закончился — режим «только чтение»: новые заказы не принимаются, данные можно смотреть и скачать копию. Чтобы продолжить, напишите TS.';

/**
 * The license status the HUB enforces for these terms at `now`: the same states and read-only rules as a signed
 * license (licenseStatus in packages/domain), worded for a café owner.
 */
export function termsLicense(terms: CafeTerms, now: number, venue: string | null): LicenseStatus {
  const until = terms.status === 'permanent' ? TRIAL_PERMANENT_LICENSE_UNTIL : terms.status === 'ended' ? Math.min(terms.endsAt ?? now, now) : terms.endsAt!;
  const payload: LicensePayload = {
    v: 1,
    id: `terms:${terms.setAt}`,
    companyId: 'cloud-cafe',
    companyName: venue ?? 'Кофейня',
    plan: terms.status === 'permanent' ? 'paid' : 'trial',
    issuedAt: terms.setAt,
    // Never "not yet": the café works from the moment the terms are set (and before, after an import).
    validFrom: Math.min(terms.setAt, until - 1000, now),
    validUntil: until,
    maxClubs: 1,
    maxTables: null,
    maxStaff: null,
    modules: { bar: true, cloud: true, hardware: true },
    hubIds: [],
    blocked: false,
  };
  const status = licenseStatus(payload, now);
  if (terms.status === 'ended') return { ...status, state: 'expired', readOnly: true, daysLeft: 0, message: terms.message ?? ENDED_TEXT };
  switch (status.state) {
    case 'expired':
      return { ...status, message: terms.message ?? `Доступ к облачной кассе закончился ${dateRu(until)} — режим «только чтение»: новые заказы не принимаются, данные можно смотреть и скачать копию. Чтобы продолжить, напишите TS.` };
    case 'last_day':
      return { ...status, message: 'Доступ к облачной кассе заканчивается сегодня. Чтобы касса не перешла в режим «только чтение», напишите TS.' };
    case 'expiring':
      return { ...status, message: `Доступ к облачной кассе заканчивается через ${status.daysLeft} дн. (${dateRu(until)}). Чтобы продлить, напишите TS.` };
    default:
      return status;
  }
}
