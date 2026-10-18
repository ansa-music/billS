export const SESSION_STATUSES = [
  'OPENING',
  'ACTIVE',
  'PAUSED',
  'AWAITING_PAYMENT',
  'CLOSED',
  'CANCELLED',
  'FAILED',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * OPENING           lamp ON requested, time is not running yet
 * ACTIVE            lamp confirmed ON, time is running
 * PAUSED            game paused by staff (or being moved to another table): the lamp is
 *                   off (or blinking), time and money do not run; resuming works like
 *                   opening — time continues only once the lamp confirms ON again
 * AWAITING_PAYMENT  stopped, the bill is fixed, the table is free again
 * CLOSED            paid
 * CANCELLED         stopped before the lamp confirmed — nothing to pay
 * FAILED            the lamp never confirmed — nothing to pay
 *
 * Storage note: the HUB keeps PAUSED games as status ACTIVE plus an open row in
 * `session_pauses`; the API and this module always expose the effective status.
 */
const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  OPENING: ['ACTIVE', 'CANCELLED', 'FAILED'],
  ACTIVE: ['PAUSED', 'AWAITING_PAYMENT'],
  PAUSED: ['ACTIVE', 'AWAITING_PAYMENT'],
  AWAITING_PAYMENT: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
  FAILED: [],
};

/** Statuses that occupy a table. At most one such game per table. */
export const LIVE_STATUSES: readonly SessionStatus[] = ['OPENING', 'ACTIVE', 'PAUSED'];

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isLive(status: SessionStatus): boolean {
  return LIVE_STATUSES.includes(status);
}
