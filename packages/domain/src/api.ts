import type { PauseSpan } from './pause.ts';
import type { SessionStatus } from './session.ts';
import type { TariffConfig } from './tariff.ts';

/** HTTP contract between the HUB and the screens. */

export type TableKind = 'pool' | 'russian' | 'snooker';
export type LampDesired = 'ON' | 'OFF';
export type LampReported = 'ON' | 'OFF' | 'UNKNOWN';

export interface SessionView {
  id: string;
  tableId: string;
  status: SessionStatus;
  tariffId: string;
  tariffName: string;
  tariff: TariffConfig;
  timezone: string;
  requestedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  /** Seconds of play: pauses excluded. Final for stopped games; for a live game — as of `serverNow`. */
  playedSeconds: number | null;
  billedSeconds: number | null;
  /** Final for stopped games; for a running game — the amount if stopped at `serverNow`. */
  amount: number | null;
  /** Unpaid pause time in seconds (staff pauses within the tariff budget + transfers). */
  pausedSeconds: number | null;
  /** All pauses of the game, oldest first; the last one is open while the game is PAUSED. */
  pauses: PauseSpan[];
  /** When the current pause started (PAUSED only). */
  pausedAt: number | null;
  /** «Продолжить» pressed (or a transfer requested): the lamp is being switched on; time resumes when it confirms. */
  resumeRequestedAt: number | null;
  failureReason: string | null;
  openedBy: string;
  stoppedBy: string | null;
}

export interface TableView {
  id: string;
  name: string;
  kind: TableKind;
  defaultTariffId: string;
  /** `blink`: the lamp was asked to blink (paused game with `pauseLamp: 'blink'`). */
  lamp: { desired: LampDesired; reported: LampReported; blink: boolean };
  session: SessionView | null;
}

export interface AlertView {
  id: string;
  at: number;
  kind: string;
  tableId: string | null;
  message: string;
}

export interface HubState {
  serverNow: number;
  club: { id: string; name: string; timezone: string; currency: string };
  tariffs: Array<{ id: string; name: string; config: TariffConfig }>;
  tables: TableView[];
  unpaid: SessionView[];
  alerts: AlertView[];
}

export interface TransferRequest {
  toTableId: string;
}

export interface ApiError {
  error: { code: string; message: string };
}
