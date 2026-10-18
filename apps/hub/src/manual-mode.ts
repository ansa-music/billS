import type { Db } from './db.ts';
import { afterCommit, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';

/**
 * Manual (emergency) mode: the relay controller is broken, staff switch the
 * lamps by hand. Games open without waiting for a lamp confirmation, billing
 * starts at the button press, and every such game is marked `manual`.
 */
export interface ManualMode {
  enabled: boolean;
  reason: string | null;
  since: number | null;
  by: string | null;
}

const KEY = 'manual_mode';
const OFF: ManualMode = { enabled: false, reason: null, since: null, by: null };

export function getManualMode(db: Db): ManualMode {
  const row = one<{ value: string }>(db, 'SELECT value FROM hub_settings WHERE key = ?', KEY);
  if (!row) return OFF;
  try {
    return { ...OFF, ...(JSON.parse(row.value) as Partial<ManualMode>) };
  } catch {
    return OFF;
  }
}

export function isManualMode(db: Db): boolean {
  return getManualMode(db).enabled;
}

export interface ManualModeInput {
  enabled: boolean;
  reason?: string | undefined;
  actor: string;
  /** Who may switch the mode off (manager). Until stage 3 roles, matched by X-Actor name. */
  isManager: (actor: string) => boolean;
}

export function setManualMode(db: Db, now: number, events: HubEvents, input: ManualModeInput): ManualMode {
  return transaction(db, () => {
    const current = getManualMode(db);
    if (input.enabled) {
      const reason = (input.reason ?? '').trim();
      if (reason.length < 3) {
        throw new HubError(422, 'REASON_REQUIRED', 'Укажите причину ручного режима (минимум 3 символа)');
      }
      if (current.enabled) return current;
      const next: ManualMode = { enabled: true, reason, since: now, by: input.actor };
      save(db, now, input.actor, next);
      record(db, now, {
        actor: input.actor,
        action: 'hub.manual_mode_on',
        entityType: 'hub',
        entityId: 'hub',
        data: { reason },
      });
      afterCommit(db, () => events.changed({ kind: 'settings' }));
      return next;
    }
    if (!input.isManager(input.actor)) {
      throw new HubError(403, 'MANAGER_REQUIRED', 'Выключить ручной режим может только управляющий');
    }
    if (!current.enabled) return current;
    save(db, now, input.actor, OFF);
    record(db, now, {
      actor: input.actor,
      action: 'hub.manual_mode_off',
      entityType: 'hub',
      entityId: 'hub',
      data: { reason: current.reason, since: current.since, enabledBy: current.by, note: input.reason ?? null },
    });
    afterCommit(db, () => events.changed({ kind: 'settings' }));
    return OFF;
  });
}

function save(db: Db, now: number, actor: string, value: ManualMode): void {
  run(
    db,
    `INSERT INTO hub_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    KEY,
    JSON.stringify(value),
    now,
    actor,
  );
}

/** Managers by name, until staff log in with a PIN (stage 3). Case-insensitive. */
export function managerMatcher(names: string[]): (actor: string) => boolean {
  const set = new Set(names.map((n) => n.trim().toLocaleLowerCase('ru')).filter(Boolean));
  return (actor) => set.has(actor.trim().toLocaleLowerCase('ru'));
}
