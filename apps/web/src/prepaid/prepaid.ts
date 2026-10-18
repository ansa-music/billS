import type { OpenTableRequest, SessionView } from '@bills/domain';
import { command } from '../api.ts';

/** Quick choices for «open for N minutes», on the card and in the prepaid dialog. */
export const PRESET_MINUTES: readonly number[] = [30, 60, 90, 120, 180];

export const NO_SHIFT_HINT = 'Откройте смену, чтобы принять предоплату';

/** 30 → «30 мин», 60 → «1 ч», 90 → «1,5 ч», 75 → «1 ч 15 мин». */
export function formatPrepaidMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  if (m === 30) return `${h},5 ч`;
  return `${h} ч ${m} мин`;
}

/** Time left: «59:12», or «1:05:09» from an hour up. Rounded up, so «00:00» means it is over. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** POST /api/tables/:tableId/open — with minutes the game is timed and paid after the HUB stops it. */
export function openTable(
  tableId: string,
  actor: string,
  tariffId: string,
  prepaidMinutes: number | null,
): Promise<SessionView> {
  const body: OpenTableRequest = prepaidMinutes != null ? { tariffId, prepaidMinutes } : { tariffId };
  return command<SessionView>(`/api/tables/${tableId}/open`, actor, body);
}
