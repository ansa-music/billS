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
  playedSeconds: number | null;
  billedSeconds: number | null;
  /** Final for stopped games; for a running game — the amount if stopped at `serverNow`. */
  amount: number | null;
  failureReason: string | null;
  openedBy: string;
  stoppedBy: string | null;
  /** Opened in manual mode: billing started at the button press, the lamp was switched by hand. */
  manual: boolean;
}

export interface TableView {
  id: string;
  name: string;
  kind: TableKind;
  defaultTariffId: string;
  lamp: {
    desired: LampDesired;
    reported: LampReported;
    /** From the last poll of the current sensor; null — no sensor or never polled. */
    currentOn: boolean | null;
    polledAt: number | null;
  };
  session: SessionView | null;
}

export interface AlertView {
  id: string;
  at: number;
  kind: string;
  tableId: string | null;
  message: string;
}

/** Emergency mode: lamps are switched by hand, games start at the button press. */
export interface ManualModeView {
  enabled: boolean;
  reason: string | null;
  since: number | null;
  by: string | null;
}

export interface HubState {
  serverNow: number;
  club: { id: string; name: string; timezone: string; currency: string };
  tariffs: Array<{ id: string; name: string; config: TariffConfig }>;
  tables: TableView[];
  unpaid: SessionView[];
  alerts: AlertView[];
  manualMode: ManualModeView;
}

export interface ApiError {
  error: { code: string; message: string };
}
