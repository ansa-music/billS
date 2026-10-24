/**
 * «Начать бесплатно»: the signup form's rules, the words for the cloud's errors and the few
 * things the cabinet remembers in this browser after signing up. Pure, tested in test/signup.test.ts.
 *
 *   POST {SUPABASE_URL}/functions/v1/signup (no auth)
 *     { email, password, venueName, businessType, timezone, ownerName? }
 *     → 201 { ok, companyId, clubId, hubId, managerKey }
 *     errors { error: { code, message } }: EMAIL_TAKEN, WEAK_PASSWORD, INVALID_EMAIL,
 *     NAME_REQUIRED, RATE_LIMITED, SIGNUP_DISABLED
 */
import type { BusinessType } from '@bills/domain';

export interface SignupRequest {
  email: string;
  password: string;
  venueName: string;
  businessType: BusinessType;
  timezone: string;
  ownerName?: string;
}

export interface SignupResponse {
  ok: true;
  companyId: string;
  clubId: string;
  hubId: string;
  /** Six digits: the manager's key to sign in at the cash register. Shown on the checklist. */
  managerKey: string;
}

export const PASSWORD_MIN = 8;
export const VENUE_NAME_MAX = 120;

export type SignupField = 'venueName' | 'email' | 'password';

export interface SignupDraft {
  venueName: string;
  email: string;
  password: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** What is wrong with each field, in plain words; empty when the form can be sent. */
export function signupProblems(d: SignupDraft): Partial<Record<SignupField, string>> {
  const out: Partial<Record<SignupField, string>> = {};
  const name = d.venueName.trim();
  if (!name) out.venueName = 'Напишите, как называется заведение';
  else if (name.length > VENUE_NAME_MAX) out.venueName = `Название длиннее ${VENUE_NAME_MAX} символов — сократите его`;
  const email = d.email.trim();
  if (!email) out.email = 'Укажите почту — на неё будет вход';
  else if (!EMAIL_RE.test(email)) out.email = 'Почта написана с ошибкой, например: name@mail.kz';
  if (!d.password) out.password = 'Придумайте пароль';
  else if (d.password.length < PASSWORD_MIN) out.password = `Пароль слишком короткий: нужно не меньше ${PASSWORD_MIN} символов`;
  return out;
}

export interface PasswordStrength {
  /** 0 empty, 1 too short / weak, 2 fine, 3 strong. */
  level: 0 | 1 | 2 | 3;
  text: string;
}

const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'qwerty123', 'qwertyui', '11111111', '00000000', 'password1', 'йцукенгш']);

/** A hint under the password field; the cloud has the final say (WEAK_PASSWORD). */
export function passwordStrength(pw: string): PasswordStrength {
  if (!pw) return { level: 0, text: `Не меньше ${PASSWORD_MIN} символов` };
  if (pw.length < PASSWORD_MIN) return { level: 1, text: `Ещё ${PASSWORD_MIN - pw.length} ${symbols(PASSWORD_MIN - pw.length)}` };
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw) || /^\d+$/.test(pw)) {
    return { level: 1, text: 'Слишком простой — добавьте буквы' };
  }
  const kinds = [/[a-zа-яё]/, /[A-ZА-ЯЁ]/, /\d/, /[^A-Za-zА-Яа-яЁё\d]/].filter((re) => re.test(pw)).length;
  if (pw.length >= 12 && kinds >= 3) return { level: 3, text: 'Надёжный пароль' };
  if (kinds >= 2 || pw.length >= 12) return { level: 2, text: 'Хороший пароль' };
  return { level: 1, text: 'Простой — добавьте цифры или заглавные буквы' };
}

function symbols(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'символ';
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'символа';
  return 'символов';
}

/** Which field an error from the cloud belongs to (to show it under that field). */
export function signupErrorField(code: string): SignupField | null {
  switch (code) {
    case 'EMAIL_TAKEN':
    case 'INVALID_EMAIL':
      return 'email';
    case 'WEAK_PASSWORD':
      return 'password';
    case 'NAME_REQUIRED':
      return 'venueName';
    default:
      return null;
  }
}

/** The cloud's error in words for someone who has never seen TS before. */
export function signupErrorText(code: string, status: number, message?: string): string {
  switch (code) {
    case 'EMAIL_TAKEN':
      return 'Эта почта уже зарегистрирована. Войдите с ней или восстановите пароль.';
    case 'INVALID_EMAIL':
      return 'Почта написана с ошибкой, например: name@mail.kz';
    case 'WEAK_PASSWORD':
      return 'Пароль слишком простой. Возьмите не меньше 8 символов: буквы и цифры.';
    case 'NAME_REQUIRED':
      return 'Напишите, как называется заведение';
    case 'RATE_LIMITED':
      return 'Слишком много попыток с этого адреса. Подождите несколько минут и попробуйте снова.';
    case 'SIGNUP_DISABLED':
      return 'Регистрация сейчас закрыта. Напишите в поддержку TS — подключим вручную.';
    case 'OFFLINE':
      return 'Нет связи с интернетом. Проверьте подключение и нажмите ещё раз.';
    case 'NOT_AVAILABLE':
      return 'Регистрация пока не работает на этом сайте. Напишите в поддержку TS — подключим вручную.';
    default:
      if (status === 404) return 'Регистрация пока не работает на этом сайте. Напишите в поддержку TS — подключим вручную.';
      if (status >= 500) return 'Сервер TS не ответил. Попробуйте ещё раз через минуту.';
      return message || 'Не получилось создать заведение. Попробуйте ещё раз.';
  }
}

// --- what the browser keeps after signing up ---------------------------------------------

const MANAGER_KEY = 'ts.cabinet.managerKey';
const VENUE_TYPES = 'ts.cabinet.venueTypes';
const RETURNING = 'ts.cabinet.returning';

export interface StoredManagerKey {
  clubId: string;
  key: string;
}

function read(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function write(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    // storage blocked: the checklist offers to issue a new key instead
  }
}

/** The one secret kept here: the six-digit key from signup, until «Войдите в кассу» is done. */
export function saveManagerKey(v: StoredManagerKey): void {
  write(MANAGER_KEY, JSON.stringify(v));
}

export function readManagerKey(clubId?: string): StoredManagerKey | null {
  const raw = read(MANAGER_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredManagerKey;
    if (typeof v?.clubId !== 'string' || typeof v.key !== 'string' || !/^\d{4,8}$/.test(v.key)) return null;
    return clubId && v.clubId !== clubId ? null : v;
  } catch {
    return null;
  }
}

export function forgetManagerKey(): void {
  write(MANAGER_KEY, null);
}

/** The venue type picked at signup — until the cloud reports it (GET /owner/onboarding). */
export function rememberVenueType(clubId: string, type: BusinessType): void {
  write(VENUE_TYPES, JSON.stringify({ ...storedVenueTypes(), [clubId]: type }));
}

export function storedVenueType(clubId: string): BusinessType | null {
  const t = storedVenueTypes()[clubId];
  return t === 'cafe' || t === 'billiards' ? t : null;
}

function storedVenueTypes(): Record<string, string> {
  try {
    const v = JSON.parse(read(VENUE_TYPES) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Someone signed in here before: the start screen opens on «Войти», not on «Начать бесплатно». */
export function markReturning(): void {
  write(RETURNING, '1');
}

export function isReturning(): boolean {
  return read(RETURNING) === '1';
}
