import type { Role } from './permissions.ts';

/**
 * Keys: how people sign in.
 *
 * Long keys — "OWNER-7K3Q-M2PX-9HWD-4RTB" — for the platform (owner, tech) and
 * the client's manager. The prefix names the role for people, the rest is
 * random. Stored as sha256 of the canonical key; a manager's key works in every
 * branch of the company, a platform key in every HUB.
 *
 * Short keys — six digits, like a PIN, easy to type on a tablet — for staff.
 * A short key belongs to ONE branch: its hash is taken over the club id and the
 * digits (`shortKeyHashInput`), the HUB keeps only the keys of its own branch,
 * and the cloud hands a HUB only the keys of that branch. Guessing is stopped by
 * the login throttle below, not by the key length.
 */

/** Long-key prefix by role. Staff roles have no long keys. */
export const KEY_ROLE_PREFIX: Partial<Record<Role, string>> = {
  owner: 'OWNER',
  tech: 'TECH',
  manager: 'MGR',
};

/** Letters and digits that are never confused with each other (no 0/O, 1/I/L). */
export const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const KEY_GROUPS = 4;
export const KEY_GROUP_LENGTH = 4;

/** Digits in a short staff key. */
export const SHORT_KEY_LENGTH = 6;

/** Sessions issued from a key live this long, sliding on use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_RE = /^[A-Z]{3,5}(?:-[A-Z2-9]{4}){4}$/;
const SHORT_RE = new RegExp(`^\\d{${SHORT_KEY_LENGTH}}$`);

export type KeyKind = 'long' | 'short';

/** What a person typed or scanned → canonical form (uppercase, dashes; digits only for a short key). */
export function normalizeAccessKey(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[\s\-_–—.]+/g, '');
  if (/^\d+$/.test(digits)) return digits;
  return trimmed
    .toUpperCase()
    .replace(/[\s_–—]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isAccessKeyShape(key: string): boolean {
  return KEY_RE.test(key);
}

export function isShortKeyShape(key: string): boolean {
  return SHORT_RE.test(key);
}

/** Which kind of key a canonical string looks like, or null for neither. */
export function keyKindOf(key: string): KeyKind | null {
  if (isShortKeyShape(key)) return 'short';
  if (isAccessKeyShape(key)) return 'long';
  return null;
}

/** "OWNER-7K3Q" for a long key, "••••42" for a short one — enough to tell keys apart in a list. */
export function keyPrefixOf(key: string): string {
  if (isShortKeyShape(key)) return `••••${key.slice(-2)}`;
  return key.split('-').slice(0, 2).join('-');
}

/** Builds a long key from a role and 16 random indices into KEY_ALPHABET. */
export function formatAccessKey(role: Role, randomIndices: ArrayLike<number>): string {
  const prefix = KEY_ROLE_PREFIX[role];
  if (!prefix) throw new Error(`Role ${role} has no long keys`);
  if (randomIndices.length < KEY_GROUPS * KEY_GROUP_LENGTH) throw new Error('Not enough randomness for a key');
  const groups: string[] = [];
  for (let g = 0; g < KEY_GROUPS; g++) {
    let s = '';
    for (let i = 0; i < KEY_GROUP_LENGTH; i++) {
      const idx = randomIndices[g * KEY_GROUP_LENGTH + i]! % KEY_ALPHABET.length;
      s += KEY_ALPHABET[idx];
    }
    groups.push(s);
  }
  return `${prefix}-${groups.join('-')}`;
}

export function roleOfKeyPrefix(key: string): Role | null {
  const p = key.split('-')[0];
  for (const [role, prefix] of Object.entries(KEY_ROLE_PREFIX) as Array<[Role, string]>) {
    if (prefix === p) return role;
  }
  return null;
}

/**
 * Six digits from random values (each 0…65535 or bigger). Weak keys (one digit
 * repeated, straight runs like 123456) are skipped: the caller passes enough
 * values for several tries and gets null if every try was weak.
 */
export function formatShortKey(randomValues: ArrayLike<number>): string | null {
  for (let start = 0; start + SHORT_KEY_LENGTH <= randomValues.length; start += SHORT_KEY_LENGTH) {
    let s = '';
    for (let i = 0; i < SHORT_KEY_LENGTH; i++) s += String(randomValues[start + i]! % 10);
    if (!isWeakShortKey(s)) return s;
  }
  return null;
}

/** 000000, 111111, 123456, 654321, 121212… — refused when a manager picks a key by hand. */
export function isWeakShortKey(key: string): boolean {
  if (!isShortKeyShape(key)) return true;
  const d = [...key].map(Number);
  if (d.every((x) => x === d[0])) return true;
  const up = d.every((x, i) => i === 0 || x === (d[i - 1]! + 1) % 10);
  const down = d.every((x, i) => i === 0 || x === (d[i - 1]! + 9) % 10);
  if (up || down) return true;
  if (key.slice(0, 2).repeat(3) === key || key.slice(0, 3).repeat(2) === key) return true;
  return false;
}

/**
 * The string whose sha256 (hex) is stored for a short key. The club id is part
 * of it, so the same six digits make a different hash in every branch, and a
 * hash copied from one branch's database means nothing in another.
 */
export function shortKeyHashInput(clubId: string, key: string): string {
  return `ts-short-key:v1:${clubId}:${key}`;
}

// ── Login throttle ──────────────────────────────────────────────────────────

/**
 * Brute-force protection for logins, per source (device + IP) and per branch.
 * A short key has only a million values, so this is what keeps it safe.
 */
export const LOGIN_THROTTLE = {
  /** Failures from one source before it has to wait. */
  freeFailures: 5,
  /** First pause, doubled with every further failure… */
  baseLockMs: 30_000,
  /** …up to this. */
  maxLockMs: 30 * 60_000,
  /** Failures are forgotten after this long without a new one. */
  windowMs: 60 * 60_000,
  /** Failures of all sources together in the window before short keys are paused for the whole branch. */
  branchFailures: 50,
  branchLockMs: 5 * 60_000,
} as const;

/** How long a source must wait after `failures` consecutive failures (0 = may try now). */
export function loginLockMs(failures: number): number {
  const t = LOGIN_THROTTLE;
  if (failures < t.freeFailures) return 0;
  return Math.min(t.baseLockMs * 2 ** (failures - t.freeFailures), t.maxLockMs);
}

// ── Login screen helpers ────────────────────────────────────────────────────

/**
 * A readable name of this device for the list of logins («Планшет Android · Chrome»), so nobody
 * has to type one: taken from the browser's user agent; the person may rename it later.
 */
export function deviceNameFromUserAgent(ua: string, touchPoints = 0): string {
  const s = ua || '';
  let device: string;
  if (/iPad/i.test(s) || (/Macintosh/i.test(s) && touchPoints > 1)) device = 'iPad';
  else if (/iPhone|iPod/i.test(s)) device = 'iPhone';
  else if (/Android/i.test(s)) device = /Mobile/i.test(s) ? 'Телефон Android' : 'Планшет Android';
  else if (/Windows/i.test(s)) device = 'Компьютер Windows';
  else if (/Macintosh|Mac OS X/i.test(s)) device = 'Mac';
  else if (/CrOS/i.test(s)) device = 'Chromebook';
  else if (/Linux/i.test(s)) device = 'Компьютер Linux';
  else device = 'Устройство';
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /YaBrowser\//.test(s)
      ? 'Яндекс Браузер'
      : /OPR\/|Opera/.test(s)
        ? 'Opera'
        : /Firefox\/|FxiOS\//.test(s)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(s)
            ? 'Chrome'
            : /Safari\//.test(s)
              ? 'Safari'
              : null;
  return browser ? `${device} · ${browser}` : device;
}

/** Up to two initials for an avatar: «Данияр Официант» → «ДО», «Асель» → «А». */
export function nameInitials(name: string): string {
  const words = name.trim().split(/[\s\-_.]+/u).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => [...w][0] ?? '');
  return letters.join('').toUpperCase() || '?';
}
