import type { TableKind } from './api.ts';
import type { Minor } from './money.ts';
import type { SessionStatus } from './session.ts';
import type { TariffConfig } from './tariff.ts';

/**
 * Stage 6: the HUB ↔ cloud sync protocol and the owner cabinet API.
 * Shared by apps/hub (sync worker), apps/cloud (server) and apps/cloud-web (cabinet).
 *
 * Direction UP   (HUB → cloud): outbox events, settings snapshot.
 * Direction DOWN (cloud → HUB): club settings (tariffs, tables, staff) by version.
 * The HUB identifies itself with `Authorization: Bearer <api key>`; the key belongs to
 * exactly one HUB, the HUB to exactly one club. `hubId` in bodies is a sanity check.
 */

// ---------------------------------------------------------------------------
// UP: outbox events
// ---------------------------------------------------------------------------

/** One audit record as written by apps/hub journal.ts `record()`. */
export interface SyncEventPayload {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
}

/** One outbox row. `id` is the HUB-local autoincrement; (hubId, id) is unique in the cloud. */
export interface SyncEvent {
  id: number;
  at: number;
  topic: string;
  payload: SyncEventPayload;
}

export interface SyncEventsRequest {
  hubId: string;
  /** Settings version the HUB has applied; the cloud answers with its own so the HUB knows to pull. */
  settingsVersion: number;
  events: SyncEvent[];
}

export interface SyncEventsResponse {
  /** Highest outbox id the cloud has stored for this HUB (after this batch), null if none yet. */
  lastAcceptedId: number | null;
  /** How many events of this batch were new (the rest were duplicates). */
  inserted: number;
  settingsVersion: number;
}

// ---------------------------------------------------------------------------
// Settings (both directions)
// ---------------------------------------------------------------------------

export interface TariffSetting {
  id: string;
  name: string;
  config: TariffConfig;
  isActive: boolean;
}

export interface TableSetting {
  id: string;
  name: string;
  kind: TableKind;
  lampChannel: string;
  defaultTariffId: string;
  sortOrder: number;
  isActive: boolean;
}

/** Stage 3 fills this in; the HUB ignores staff it does not understand yet. */
export interface StaffSetting {
  id: string;
  name: string;
  role: 'manager' | 'cashier' | 'waiter';
  isActive: boolean;
}

export interface ClubSettings {
  /** Monotonic per club. 0 = nothing edited in the cloud yet. */
  version: number;
  club: { name: string; timezone: string; currency: string };
  tariffs: TariffSetting[];
  tables: TableSetting[];
  staff: StaffSetting[];
}

/**
 * UP: the HUB reports its current settings so the owner can see and edit them.
 * Accepted when the HUB is on the cloud's version (or the cloud has none);
 * refused (409) when the HUB is behind — it must pull first.
 */
export interface SyncSnapshotRequest {
  hubId: string;
  settingsVersion: number;
  club: { name: string; timezone: string; currency: string };
  tariffs: TariffSetting[];
  tables: TableSetting[];
}

export interface SyncSnapshotResponse {
  accepted: boolean;
  settingsVersion: number;
}

/** DOWN: GET /sync/settings?since=<version>. */
export type SyncSettingsResponse = { changed: false; version: number } | ({ changed: true } & ClubSettings);

/** Reported by the HUB in GET /api/state as `sync`. */
export interface SyncStatus {
  /** false when CLOUD_URL is not configured — the club runs standalone. */
  enabled: boolean;
  lastSentAt: number | null;
  /** Outbox rows not yet confirmed by the cloud. */
  pending: number;
  lastError: string | null;
  lastErrorAt: number | null;
  settingsVersion: number;
}

// ---------------------------------------------------------------------------
// Owner cabinet
// ---------------------------------------------------------------------------

export interface OwnerView {
  id: string;
  email: string;
  name: string;
  company: { id: string; name: string };
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface PeriodStats {
  /** Billed amount of stopped games, minor units. */
  revenue: Minor;
  games: number;
  playedSeconds: number;
}

export interface HubStatus {
  id: string;
  name: string;
  lastSeenAt: number | null;
  /** Seen within the last few minutes. */
  online: boolean;
  lastOutboxId: number | null;
  /** Settings version the HUB reported as applied. */
  settingsVersion: number;
  /** The cloud has newer settings the HUB has not pulled yet. */
  pendingSettings: boolean;
}

export interface ClubSummary {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  today: PeriodStats;
  week: PeriodStats;
  month: PeriodStats;
  openAlerts: number;
  /** Games running right now according to the last events. */
  liveGames: number;
  tablesCount: number;
  hub: HubStatus | null;
}

export interface CloudAlertView {
  id: string;
  clubId: string;
  clubName: string;
  at: number;
  kind: string;
  tableId: string | null;
  tableName: string | null;
  message: string;
  resolvedAt: number | null;
}

export interface OwnerOverview {
  serverNow: number;
  company: { id: string; name: string };
  clubs: ClubSummary[];
  totals: { today: PeriodStats; week: PeriodStats; month: PeriodStats };
  /** Open alerts across all clubs, newest first. */
  alerts: CloudAlertView[];
}

/** `day` is a local calendar date of the club, YYYY-MM-DD. */
export interface DayStats {
  day: string;
  revenue: Minor;
  games: number;
  playedSeconds: number;
  alerts: number;
}

/** Load of a club by local hour of day, summed over the period. */
export interface HourLoad {
  hour: number;
  busySeconds: number;
  games: number;
}

export interface TableStats {
  id: string;
  name: string;
  kind: TableKind;
  revenue: Minor;
  games: number;
  playedSeconds: number;
  /** busySeconds per local hour 0…23 over the period. */
  byHour: number[];
}

export interface CloudSessionView {
  id: string;
  clubId: string;
  tableId: string;
  tableName: string | null;
  status: SessionStatus;
  tariffName: string | null;
  openedBy: string;
  requestedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  billedSeconds: number | null;
  amount: Minor | null;
}

export interface ClubDetails {
  club: ClubSummary;
  /** Last 30 local days, oldest first. */
  days: DayStats[];
  /** Last 7 local days by hour. */
  hours: HourLoad[];
  /** Last 30 days per table. */
  tables: TableStats[];
  /** Open first, then recently resolved. */
  alerts: CloudAlertView[];
  recentSessions: CloudSessionView[];
  settings: ClubSettings;
}

export interface UpdateTariffsRequest {
  /** Full list: tariffs missing here are deactivated, new ones (no id) get an id. */
  tariffs: Array<Omit<TariffSetting, 'id'> & { id?: string }>;
}

export interface UpdateTariffsResponse {
  settings: ClubSettings;
}
