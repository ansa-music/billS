import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { one, run } from './db.ts';

export const SYSTEM = 'system';

export interface JournalEntry {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
}

/** Writes an audit record and queues the same event for the cloud. Call inside a transaction. */
export function record(db: Db, at: number, entry: JournalEntry): void {
  const data = JSON.stringify(entry.data);
  run(
    db,
    'INSERT INTO audit_log (at, actor, action, entity_type, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)',
    at,
    entry.actor,
    entry.action,
    entry.entityType,
    entry.entityId,
    data,
  );
  run(db, 'INSERT INTO outbox (at, topic, payload) VALUES (?, ?, ?)', at, entry.action, JSON.stringify(entry));
}

export interface AlertInput {
  kind: string;
  tableId: string | null;
  sessionId: string | null;
  message: string;
}

/**
 * Raises an alert for staff and the owner. While an alert of the same kind for
 * a table is unresolved, repeats are folded into it; lamp command alerts
 * (LAMP_*) are folded into any open lamp command alert of the table.
 */
export function raiseAlert(db: Db, at: number, alert: AlertInput): void {
  if (alert.tableId) {
    const sameKind = one<{ id: string }>(
      db,
      'SELECT id FROM alerts WHERE table_id = ? AND kind = ? AND resolved_at IS NULL',
      alert.tableId,
      alert.kind,
    );
    if (sameKind) return;
    if (alert.kind.startsWith('LAMP_')) {
      const open = one<{ id: string }>(
        db,
        "SELECT id FROM alerts WHERE table_id = ? AND kind LIKE 'LAMP\\_%' ESCAPE '\\' AND resolved_at IS NULL",
        alert.tableId,
      );
      if (open) return;
    }
  }
  const id = randomUUID();
  run(
    db,
    'INSERT INTO alerts (id, at, kind, table_id, session_id, message) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    at,
    alert.kind,
    alert.tableId,
    alert.sessionId,
    alert.message,
  );
  record(db, at, {
    actor: SYSTEM,
    action: 'alert.raised',
    entityType: 'alert',
    entityId: id,
    data: { ...alert },
  });
}
