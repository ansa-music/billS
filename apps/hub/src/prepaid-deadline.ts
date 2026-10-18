import type { TariffConfig } from '@bills/domain';
import { prepaidDeadline, unpaidSpans } from '@bills/domain';
import type { Db } from './db.ts';
import { one, run } from './db.ts';
import { record, SYSTEM } from './journal.ts';
import { loadPauseSpans } from './views.ts';

/**
 * Keeps `prepaid_games.deadline_at` in line with the game: lamp-confirmed start +
 * prepaid minutes + the unpaid time of every closed pause (staff pause within the
 * tariff budget, transfer, power loss). Called when the game starts and whenever a
 * pause closes — from `SessionService` (manual mode) and the lamp controller (the
 * lamp confirmed ON). A pause that pushes the end back out of the warning window
 * re-arms the 5-minute blink. Does nothing for games that are not prepaid.
 *
 * Lives apart from `sessions.ts` so the lamp controller can call it without a cycle.
 */
export function shiftPrepaidDeadline(db: Db, sessionId: string, now: number): void {
  const row = one<{
    minutes: number;
    deadline_at: number | null;
    warned_at: number | null;
    started_at: number | null;
    tariff_snapshot: string;
  }>(
    db,
    `SELECT p.minutes, p.deadline_at, p.warned_at, s.started_at, s.tariff_snapshot
     FROM prepaid_games p JOIN table_sessions s ON s.id = p.session_id
     WHERE p.session_id = ? AND p.settled_at IS NULL AND p.ended_at IS NULL`,
    sessionId,
  );
  if (!row || row.started_at === null) return;
  const tariff = JSON.parse(row.tariff_snapshot) as TariffConfig;
  // Only closed pauses move the deadline; an open one is handled when it closes.
  const closed = loadPauseSpans(db, sessionId).filter((p) => p.to !== null);
  const unpaidMs = unpaidSpans(closed, tariff, now).reduce((sum, s) => sum + (s.to - s.from), 0);
  const deadline = prepaidDeadline(row.started_at, row.minutes) + unpaidMs;
  if (deadline === row.deadline_at) return;
  // A pause never changes the play time left, so a warning already given stands
  // (the lamp blinked at "5 minutes of play left" and that is still true).
  run(db, 'UPDATE prepaid_games SET deadline_at = ? WHERE session_id = ?', deadline, sessionId);
  if (row.deadline_at !== null) {
    record(db, now, {
      actor: SYSTEM,
      action: 'session.prepaid_deadline_shifted',
      entityType: 'session',
      entityId: sessionId,
      data: { from: row.deadline_at, to: deadline, unpaidMs, warnedAt: row.warned_at },
    });
  }
}
