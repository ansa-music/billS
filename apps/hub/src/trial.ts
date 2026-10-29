import { isWeakShortKey, SHORT_KEY_LENGTH } from '@bills/domain';
import { one, run, transaction } from './db.ts';
import type { Hub } from './hub.ts';
import { seedEmptyClub } from './seed.ts';
import { applyTemplate } from './templates.ts';

/**
 * The browser trial (apps/web, VITE_TRIAL=1): a coffee shop that runs in one browser for
 * two weeks, without a cabinet or a HUB box. Its first start makes the club the person
 * described on the welcome screen — their name for it, coffee-shop mode, optionally the
 * sample menu — and one manager with a six-digit key to sign in with.
 */
export interface TrialSetup {
  venue: string;
  managerName: string;
  /** Six digits; `trialKey()` makes one. */
  key: string;
  timezone: string;
  withMenu: boolean;
  now: number;
}

/** A random six-digit key that is not a weak one (no 111111, 123456…). */
export function trialKey(random: () => number = Math.random): string {
  for (;;) {
    let key = '';
    for (let i = 0; i < SHORT_KEY_LENGTH; i++) key += Math.floor(random() * 10).toString();
    if (!isWeakShortKey(key)) return key;
  }
}

/** Sets the trial club up on an empty database. Returns false when the database already had a club. */
export function setupTrialClub(hub: Hub, setup: TrialSetup): boolean {
  const venue = setup.venue.trim().slice(0, 80) || 'Моя кофейня';
  const managerName = setup.managerName.trim().slice(0, 80) || 'Управляющий';
  const created = transaction(hub.db, () => {
    if (!seedEmptyClub(hub.db, setup.now, setup.timezone)) return false;
    const club = one<{ id: string; company_id: string }>(hub.db, 'SELECT id, company_id FROM clubs ORDER BY created_at LIMIT 1')!;
    run(hub.db, 'UPDATE companies SET name = ? WHERE id = ?', venue, club.company_id);
    run(hub.db, 'UPDATE clubs SET name = ?, settings = ? WHERE id = ?', venue, JSON.stringify({ business: { type: 'cafe' } }), club.id);
    return true;
  });
  if (!created) return false;
  hub.auth.issueFixedKeys([{ roles: ['manager'], name: managerName, key: setup.key }]);
  if (setup.withMenu) applyTemplate(hub, 'menu-cafe', managerName);
  return true;
}
