import type { Role } from './permissions.ts';

/**
 * Access keys: how staff sign in. A key is a secret string shown once when it
 * is issued; the HUB stores only its hash. The prefix names the role for
 * people ("OWNER-7K3Q…"), the rest is random. Keys are issued top-down:
 * platform tech → owner → club manager → cashier / waiter (see
 * ASSIGNABLE_ROLES in permissions.ts).
 */

export const KEY_ROLE_PREFIX: Record<Role, string> = {
  superadmin: 'TECH',
  owner: 'OWNER',
  manager: 'MGR',
  cashier: 'CASH',
  waiter: 'WTR',
};

/** Letters and digits that are never confused with each other (no 0/O, 1/I/L). */
export const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const KEY_GROUPS = 4;
export const KEY_GROUP_LENGTH = 4;

/** Sessions issued from a key live this long, sliding on use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_RE = /^[A-Z]{3,5}(?:-[A-Z2-9]{4}){4}$/;

/** What a person typed or scanned → canonical form (uppercase, dashes). */
export function normalizeAccessKey(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s_–—]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isAccessKeyShape(key: string): boolean {
  return KEY_RE.test(key);
}

/** "OWNER-7K3Q" — enough to tell keys apart in a list without revealing them. */
export function keyPrefixOf(key: string): string {
  return key.split('-').slice(0, 2).join('-');
}

/** Builds a key from a role and 16 random indices into KEY_ALPHABET. */
export function formatAccessKey(role: Role, randomIndices: ArrayLike<number>): string {
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
  return `${KEY_ROLE_PREFIX[role]}-${groups.join('-')}`;
}

export function roleOfKeyPrefix(key: string): Role | null {
  const p = key.split('-')[0];
  for (const [role, prefix] of Object.entries(KEY_ROLE_PREFIX) as Array<[Role, string]>) {
    if (prefix === p) return role;
  }
  return null;
}
