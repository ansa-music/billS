/**
 * Pure helpers of the platform and manager cabinets: license state in words and colour,
 * the license form → LicenseTermsRequest, error codes → Russian. No browser globals, so
 * `node --test` runs them as is.
 */
import type { LicenseModule, LicenseState, LicenseStatus, LicenseTerm, LicenseTermsRequest, LicenseView } from '@bills/domain';
import { LICENSE_MODULES, MODULE_LABEL, isWeakShortKey, licenseTermEnd } from '@bills/domain';

/** Kazakhstan time (UTC+5): license dates are local days there (see licenseTermEnd). */
const KZ_OFFSET_MS = 5 * 3_600_000;

/** YYYY-MM-DD of an instant in UTC+5. */
export function kzIsoDate(ms: number): string {
  return new Date(ms + KZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 31.12.2026 of an instant in UTC+5. */
export function kzDate(ms: number): string {
  const [y, m, d] = kzIsoDate(ms).split('-');
  return `${d}.${m}.${y}`;
}

/** The last day access works (validUntil is exclusive), «31.12.2026». */
export function lastLicenseDay(validUntil: number): string {
  return kzDate(validUntil - 1);
}

// ── State ───────────────────────────────────────────────────────────────────

export const LICENSE_STATE_LABEL: Record<LicenseState, string> = {
  active: 'Действует',
  expiring: 'Скоро закончится',
  last_day: 'Последний день',
  expired: 'Истекла',
  blocked: 'Заблокирована',
  not_yet: 'Ещё не началась',
  wrong_hub: 'Другой филиал',
  missing: 'Нет лицензии',
  invalid: 'Подпись не прошла',
};

export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

export function licenseTone(state: LicenseState | null | undefined): Tone {
  switch (state) {
    case 'active':
      return 'ok';
    case 'expiring':
    case 'not_yet':
      return 'warn';
    case 'last_day':
    case 'expired':
    case 'blocked':
    case 'wrong_hub':
    case 'invalid':
      return 'danger';
    default:
      return 'muted';
  }
}

export function planLabel(plan: 'trial' | 'paid' | null | undefined): string {
  return plan === 'trial' ? 'Пробная' : plan === 'paid' ? 'Оплаченная' : '—';
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

export function daysWord(n: number): string {
  return `${n} ${plural(n, 'день', 'дня', 'дней')}`;
}

export function branchesWord(n: number): string {
  return `${n} ${plural(n, 'филиал', 'филиала', 'филиалов')}`;
}

/** «до 31.12.2026 · осталось 12 дней», «истекла 01.10.2026», «нет лицензии». */
export function licenseTermText(status: LicenseStatus): string {
  if (status.validUntil === null) return 'нет лицензии';
  const last = lastLicenseDay(status.validUntil);
  if (status.state === 'expired') return `истекла ${kzDate(status.validUntil)}`;
  if (status.state === 'last_day') return `до ${last} · последний день`;
  if (status.state === 'blocked') return `до ${last} · заблокирована`;
  return `до ${last} · осталось ${daysWord(status.daysLeft ?? 0)}`;
}

/** «Бар, облако» / «—». */
export function modulesText(modules: Record<LicenseModule, boolean> | null | undefined): string {
  if (!modules) return '—';
  const on = LICENSE_MODULES.filter((m) => modules[m]).map((m) => MODULE_LABEL[m].toLowerCase());
  if (on.length === 0) return 'без модулей';
  const text = on.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «2 из 3» — branches used of the license limit. */
export function branchesUsage(used: number, max: number | null | undefined): string {
  return max === null || max === undefined ? String(used) : `${used} из ${max}`;
}

export function clubLimitText(max: number): string {
  return `Лимит лицензии: ${branchesWord(max)}`;
}

/** May the client add one more branch? */
export function canAddBranch(used: number, status: LicenseStatus | null | undefined): boolean {
  if (!status || status.readOnly) return false;
  return status.maxClubs === null || used < status.maxClubs;
}

// ── License form ────────────────────────────────────────────────────────────

export type TermChoice = 'trial3' | 'trial7' | 'months' | 'until' | 'keep';

export interface LicenseDraft {
  term: TermChoice;
  /** As typed. */
  months: string;
  /** YYYY-MM-DD from <input type=date>. */
  until: string;
  maxClubs: string;
  /** Empty = no limit. */
  maxTables: string;
  maxStaff: string;
  modules: Record<LicenseModule, boolean>;
  /** Extension: count the new term from the end of the current one. */
  fromCurrentEnd: boolean;
}

export const TERM_LABEL: Record<TermChoice, string> = {
  trial3: 'Пробная, 3 дня',
  trial7: 'Пробная, 7 дней',
  months: 'Месяцы',
  until: 'До даты',
  keep: 'Оставить срок',
};

export function emptyLicenseDraft(): LicenseDraft {
  return {
    term: 'trial7',
    months: '1',
    until: '',
    maxClubs: '1',
    maxTables: '',
    maxStaff: '',
    modules: { bar: true, cloud: true, hardware: true },
    fromCurrentEnd: true,
  };
}

/** The form pre-filled from a client's current license: same limits and modules, a paid month by default. */
export function draftFromLicense(view: LicenseView | null): LicenseDraft {
  const draft = emptyLicenseDraft();
  if (!view) return draft;
  const p = view.payload;
  return {
    ...draft,
    term: 'months',
    maxClubs: String(p.maxClubs),
    maxTables: p.maxTables === null ? '' : String(p.maxTables),
    maxStaff: p.maxStaff === null ? '' : String(p.maxStaff),
    modules: { ...draft.modules, ...p.modules },
  };
}

export type BuildResult = { ok: true; request: LicenseTermsRequest } | { ok: false; message: string };

function positiveInt(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 ? n : null;
}

/** Empty → null (no limit); a bad number → undefined. */
function optionalLimit(text: string): number | null | undefined {
  if (!text.trim()) return null;
  return positiveInt(text) ?? undefined;
}

export function termOf(draft: LicenseDraft, current: LicenseView | null): LicenseTerm | string {
  switch (draft.term) {
    case 'trial3':
      return { kind: 'trial', days: 3 };
    case 'trial7':
      return { kind: 'trial', days: 7 };
    case 'months': {
      const months = positiveInt(draft.months);
      if (months === null || months > 36) return 'Число месяцев — от 1 до 36';
      return { kind: 'months', months };
    }
    case 'until':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.until)) return 'Выберите дату окончания';
      return { kind: 'until', date: draft.until };
    case 'keep':
      if (!current) return 'У клиента ещё нет лицензии — выберите срок';
      return { kind: 'until', date: kzIsoDate(current.payload.validUntil - 1) };
  }
}

/**
 * Form → request. `now` checks that the term ends in the future; `current` is the
 * client's license when extending (enables 'keep' and «от конца текущего»).
 */
export function buildTermsRequest(draft: LicenseDraft, now: number, current: LicenseView | null = null): BuildResult {
  const term = termOf(draft, current);
  if (typeof term === 'string') return { ok: false, message: term };
  const maxClubs = positiveInt(draft.maxClubs);
  if (maxClubs === null || maxClubs > 1000) return { ok: false, message: 'Максимум филиалов — целое число от 1' };
  const maxTables = optionalLimit(draft.maxTables);
  if (maxTables === undefined) return { ok: false, message: 'Максимум столов — целое число от 1 или пусто (без ограничения)' };
  const maxStaff = optionalLimit(draft.maxStaff);
  if (maxStaff === undefined) return { ok: false, message: 'Максимум сотрудников — целое число от 1 или пусто (без ограничения)' };
  const from = current && draft.fromCurrentEnd && draft.term !== 'keep' ? Math.max(now, current.payload.validUntil) : now;
  try {
    licenseTermEnd(term, from);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const request: LicenseTermsRequest = {
    term,
    plan: term.kind === 'trial' ? 'trial' : 'paid',
    maxClubs,
    maxTables,
    maxStaff,
    modules: { ...draft.modules },
  };
  if (current) request.fromCurrentEnd = draft.term === 'keep' ? false : draft.fromCurrentEnd;
  return { ok: true, request };
}

/** «Доступ до 31.12.2026» — what the form will give, or null while it is incomplete. */
export function termPreview(draft: LicenseDraft, now: number, current: LicenseView | null = null): string | null {
  const term = termOf(draft, current);
  if (typeof term === 'string') return null;
  const from = current && draft.fromCurrentEnd && draft.term !== 'keep' ? Math.max(now, current.payload.validUntil) : now;
  try {
    return `Доступ до ${lastLicenseDay(licenseTermEnd(term, from))} включительно`;
  } catch {
    return null;
  }
}

// ── Short keys ──────────────────────────────────────────────────────────────

/** A key the manager typed: null when fine, otherwise why not (checked before sending). */
export function shortKeyProblem(input: string): string | null {
  const key = input.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(key)) return 'Ключ — ровно 6 цифр';
  if (isWeakShortKey(key)) return 'Слишком простой ключ (одинаковые цифры, 123456, 121212…) — придумайте другой';
  return null;
}

/** «••••42 · до 31.12.2026», «отозван». */
export function keyStateText(k: { expiresAt: number | null; revokedAt: number | null }, now: number): string {
  if (k.revokedAt !== null) return `отозван ${kzDate(k.revokedAt)}`;
  if (k.expiresAt === null) return 'бессрочный';
  if (k.expiresAt <= now) return `истёк ${kzDate(k.expiresAt)}`;
  return `до ${kzDate(k.expiresAt)}`;
}

export function isKeyLive(k: { expiresAt: number | null; revokedAt: number | null }, now: number): boolean {
  return k.revokedAt === null && (k.expiresAt === null || k.expiresAt > now);
}

// ── Errors ──────────────────────────────────────────────────────────────────

const ERROR_TEXT: Record<string, string> = {
  KEY_WEAK: 'Слишком простой ключ — придумайте другой или выберите случайный',
  KEY_TAKEN: 'Такой ключ уже есть у другого сотрудника этого филиала — выберите другой',
  LICENSE_STAFF_LIMIT: 'Лимит лицензии: больше активных сотрудников в филиале завести нельзя. Отключите кого-то или расширьте лицензию.',
  LICENSE_CLUB_LIMIT: 'Лимит лицензии по филиалам исчерпан. Чтобы открыть ещё один, расширьте лицензию у владельца платформы TS.',
  LICENSE_READ_ONLY: 'Лицензия истекла или приостановлена — режим «только чтение». Продлите доступ у владельца платформы TS.',
  LICENSE_MODULE_OFF: 'Этот модуль не входит в лицензию',
  FORBIDDEN: 'Недостаточно прав',
  OFFLINE: 'Нет связи с облаком',
  KEY_INVALID: 'Ключ не подходит: неверный или отозван',
  LOGIN_LOCKED: 'Слишком много попыток — подождите и попробуйте снова',
};

export function describeCabinetError(err: unknown): string {
  const e = err as { code?: string; message?: string; status?: number };
  if (e?.code && ERROR_TEXT[e.code]) return ERROR_TEXT[e.code]!;
  if (e?.status === 403) return e.message || ERROR_TEXT.FORBIDDEN!;
  return e?.message || 'Не удалось выполнить действие';
}
