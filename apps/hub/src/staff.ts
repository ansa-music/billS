import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import type { HubEvents } from './events.ts';

/** PIN storage: "scrypt$<salt hex>$<hash hex>". A PIN is 4–6 digits. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface StaffServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

/** Service for staff, PIN, audit log: see api.ts (StaffView, AuditListResponse, …). Every command is one transaction with an audit record. */
export class StaffService {
  readonly deps: StaffServiceDeps;

  constructor(deps: StaffServiceDeps) {
    this.deps = deps;
  }
}
