import type { TableKind } from './api.ts';
import type { KeyKind } from './auth.ts';
import type { PaymentMethod } from './billing.ts';
import type { BusinessType } from './cafe.ts';
import type { LicensePayload, LicenseStatus, LicenseTerm } from './license.ts';
import type { LicenseModule, PlatformRole, Role } from './permissions.ts';
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
  /**
   * Version of this HUB's access package (license, people, keys). When it differs
   * from what the HUB applied, the HUB pulls GET /sync/access. Absent from an older cloud.
   */
  accessVersion?: number;
  /**
   * «Онлайн-бронь столов» (Supabase cloud only): version of the club's bookings. When it differs
   * from what the HUB applied, the HUB pulls GET /sync/bookings (SyncBookingsResponse in
   * booking.ts). Absent while the club never set up online booking, and from the self-hosted cloud.
   */
  bookingsVersion?: number;
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

export interface ClubSnapshot {
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
export type { PaymentMethod };

export type SyncSettingsResponse = ({ changed: false; version: number } | ({ changed: true } & ClubSnapshot)) & {
  /**
   * What the branch is (set at sign-up in the cabinet, changed by the manager there): the HUB
   * switches its club setting `business.type` to it. In every answer, `changed: false` too —
   * the HUB's connection check (GET /sync/settings with a far-future `since`) sees it at once.
   * Absent from an older cloud: the HUB keeps its own setting then.
   */
  business?: { type: BusinessType };
};

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

export interface CloudLoginRequest {
  email: string;
  password: string;
}

/** Money by payment method, minor units. */
export interface PaymentTotals {
  cash: Minor;
  card: Minor;
  qr: Minor;
  total: Minor;
}

export interface PeriodStats {
  /** Paid minus refunded, by the local day of the payment (what the till actually took). */
  revenue: Minor;
  /** Billed on «Стоп» (accrued), by the local day of the stop; voided games are taken out. */
  billed: Minor;
  games: number;
  playedSeconds: number;
  /** Gross payments by method. */
  paid: PaymentTotals;
  refunded: Minor;
  /** Checks fully paid. */
  checksPaid: number;
  /** Discounts on checks paid. */
  discounts: Minor;
  /** revenue / checksPaid, 0 when none. */
  averageCheck: Minor;
  /** Games voided with a manager's approval. */
  cancelledGames: number;
}

export interface CloudShiftView {
  id: string;
  clubId: string;
  clubName: string;
  number: number;
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  openedBy: string;
  closedAt: number | null;
  closedBy: string | null;
  openingFloat: Minor;
  /** From payments of the shift (the HUB's Z report figures once closed). */
  sales: PaymentTotals;
  refunds: PaymentTotals;
  net: PaymentTotals;
  deposits: Minor;
  withdrawals: Minor;
  expectedCash: Minor | null;
  countedCash: Minor | null;
  /** counted − expected: positive surplus, negative shortage; null while open. */
  difference: Minor | null;
  note: string | null;
  checksPaid: number;
  paymentsCount: number;
  refundsCount: number;
}

export interface PowerOutageView {
  id: string;
  clubId: string;
  startedAt: number;
  endedAt: number | null;
  /** Battery went critical during the outage. */
  critical: boolean;
  /** Games the HUB paused automatically. */
  pausedGames: number;
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
  /** The open cash shift, if any. */
  openShift: CloudShiftView | null;
  /** Shift closed last; its difference is what the owner wants to see. */
  lastClosedShift: CloudShiftView | null;
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
  /** Shifts closed in the last 7 days across all clubs, newest first. */
  recentShifts: CloudShiftView[];
}

/** `day` is a local calendar date of the club, YYYY-MM-DD. */
export interface DayStats {
  day: string;
  /** Paid minus refunded that day. */
  revenue: Minor;
  /** Billed on stop that day. */
  billed: Minor;
  games: number;
  playedSeconds: number;
  paid: PaymentTotals;
  refunded: Minor;
  checksPaid: number;
  discounts: Minor;
  alerts: number;
  cancelledGames: number;
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
  stoppedBy: string | null;
  requestedAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  billedSeconds: number | null;
  /** Unpaid pause time of a stopped game. */
  pausedSeconds: number | null;
  amount: Minor | null;
  /** Check the game is billed on (stage 2). */
  checkId: string | null;
  checkNumber: number | null;
  /** When the check was fully paid (status CLOSED). */
  paidAt: number | null;
  /** Reason of a void with a manager's approval (status CANCELLED) or of a failed start. */
  cancelReason: string | null;
  cancelApprovedBy: string | null;
  /** «На N минут» game. */
  prepaidMinutes: number | null;
  /** PAUSED only: when the current pause began and why ('pause' | 'transfer' | 'power'). */
  pausedAt: number | null;
  pauseReason: string | null;
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
  /** Last 30 days, newest first (the open one first).  */
  shifts: CloudShiftView[];
  /** Power outages of the last 30 days, newest first. */
  outages: PowerOutageView[];
  settings: ClubSnapshot;
}

export interface UpdateTariffsRequest {
  /** Full list: tariffs missing here are deactivated, new ones (no id) get an id. */
  tariffs: Array<Omit<TariffSetting, 'id'> & { id?: string }>;
}

export interface UpdateTariffsResponse {
  settings: ClubSnapshot;
}

// ---------------------------------------------------------------------------
// DOWN: access package — license, people and keys of ONE branch
// ---------------------------------------------------------------------------

/**
 * GET /sync/access (HUB api key) — what this HUB needs to let people in:
 *  - the signed license of the client (`TS1.…`, see license.ts), null if none;
 *  - people: the platform team (scope 'platform'), the company's managers
 *    ('company') and the staff of THIS branch only ('club');
 *  - their keys as hashes: long keys sha256(key), short keys
 *    sha256(shortKeyHashInput(clubId, key)) — the cloud never sends a key of
 *    another branch, so a short key cannot work anywhere else.
 * The HUB replaces everything it got from the cloud before (origin 'cloud') with
 * this package in one transaction; people it created itself are kept.
 */
export interface SyncAccessResponse {
  version: number;
  license: string | null;
  /** The cloud's club id of this HUB's branch (short-key hashes are taken over it). */
  clubId: string;
  people: SyncPerson[];
  keys: SyncKey[];
  /**
   * Same as SyncSettingsResponse.business. A change of the business type in the cabinet bumps
   * the branch's access version, so the HUB learns it here without a settings version of its own.
   */
  business?: { type: BusinessType };
}

export interface SyncPerson {
  id: string;
  name: string;
  roles: Role[];
  isActive: boolean;
  scope: 'platform' | 'company' | 'club';
}

export interface SyncKey {
  id: string;
  personId: string;
  kind: KeyKind;
  /** sha256 hex, see SyncAccessResponse. */
  keyHash: string;
  prefix: string;
  label: string | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

// ---------------------------------------------------------------------------
// Platform cabinet (owner and tech of TS): clients and their licenses
// ---------------------------------------------------------------------------
//
// apps/cloud (cookie `ts_platform`) and Supabase Edge Function `platform`
// (Bearer platform session token, verify_jwt = false):
//   POST /api/platform/login            PlatformLoginRequest → PlatformLoginResponse (long key OWNER-… / TECH-…)
//   GET  /api/platform/me               → PlatformMe
//   POST /api/platform/logout
//   GET  /api/platform/clients          → { clients: ClientView[] }
//   POST /api/platform/clients          CreateClientRequest → CreateClientResponse
//   POST /api/platform/clients/:companyId/license  LicenseTermsRequest → ClientView   (extend / change terms; re-signs)
//   POST /api/platform/clients/:companyId/block    BlockClientRequest → ClientView
//   POST /api/platform/clients/:companyId/manager-key → IssuedLongKey   (new MGR-… key for the HUBs; old ones stay until revoked)
// Supabase paths are the same without `/api` under /functions/v1/platform.

export interface PlatformLoginRequest {
  key: string;
}

export interface PlatformMe {
  id: string;
  name: string;
  role: PlatformRole;
}

export interface PlatformLoginResponse {
  me: PlatformMe;
  /** Supabase only: send as `Authorization: Bearer`. apps/cloud sets a cookie instead. */
  token?: string;
  expiresAt: number;
}

/** Terms as the platform owner picks them; the cloud turns them into a signed LicensePayload. */
export interface LicenseTermsRequest {
  term: LicenseTerm;
  plan?: 'trial' | 'paid';
  maxClubs: number;
  maxTables?: number | null;
  maxStaff?: number | null;
  modules: Record<LicenseModule, boolean>;
  /**
   * Extension only: start the new term at the end of the current one (default)
   * instead of now. Ignored for a client without a license.
   */
  fromCurrentEnd?: boolean;
}

export interface LicenseView {
  payload: LicensePayload;
  status: LicenseStatus;
  /** The signed text, ready to paste into a HUB without a cloud connection. */
  signed: string;
}

export interface ClientView {
  companyId: string;
  companyName: string;
  createdAt: number;
  managers: Array<{ id: string; name: string; email: string }>;
  branches: Array<{ id: string; name: string; hubIds: string[]; lastSeenAt: number | null }>;
  license: LicenseView | null;
  blocked: boolean;
  blockedReason: string | null;
}

export interface CreateClientRequest {
  companyName: string;
  managerName: string;
  managerEmail: string;
  /** apps/cloud: the manager's cabinet password (8+ chars); a random one is made and returned when omitted. Supabase: ignored (the manager signs up with this email). */
  managerPassword?: string;
  license: LicenseTermsRequest;
}

/**
 * Edge Function `invite-manager` (Supabase): how the manager got access to the cabinet.
 * 'invited' — Supabase sent an invitation letter (new account); 'reset-sent' — the account
 * already existed, a password-reset letter went out instead.
 */
export interface ManagerInviteResponse {
  status: 'invited' | 'reset-sent';
  email: string;
  /** Where the letter's link leads: <cabinet>/#/set-password. */
  redirectTo: string;
}

/** `invite-manager` temp-password: shown ONCE to the platform; the manager must change it on first sign-in. */
export interface ManagerTempPasswordResponse {
  email: string;
  password: string;
  /** true — the Auth account was created now; false — an existing one got the new password. */
  created: boolean;
}

export interface IssuedLongKey {
  /** Shown once: MGR-… */
  key: string;
  prefix: string;
}

export interface CreateClientResponse {
  client: ClientView;
  /** The manager's long key for the HUBs (shown once). */
  managerKey: IssuedLongKey;
  /** apps/cloud only, when the password was generated: shown once. */
  managerPassword?: string;
}

export interface BlockClientRequest {
  blocked: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Manager cabinet (the client): license, branches, staff and short keys
// ---------------------------------------------------------------------------
//
// apps/cloud (owner cookie — the `owners` table holds the client's managers) and
// Supabase Edge Function `owner` (Supabase Auth JWT), paths under /owner/company/…:
//   GET  /api/company/license                 → { license: LicenseView | null }
//   GET  /api/company/branches                → { branches: BranchView[] }
//   POST /api/company/branches                CreateBranchRequest → CreateBranchResponse
//                                             409 LICENSE_CLUB_LIMIT past maxClubs, 403 LICENSE_READ_ONLY when expired/blocked
//   GET  /api/company/staff?clubId=           → { staff: CloudStaffView[] }
//   POST /api/company/staff                   CreateCloudStaffRequest → CloudStaffView (409 LICENSE_STAFF_LIMIT)
//   POST /api/company/staff/:id/update        UpdateCloudStaffRequest → CloudStaffView
//   POST /api/company/staff/:id/keys          IssueCloudKeyRequest → IssueCloudKeyResponse (short key, 6 digits)
//   POST /api/company/keys/:id/revoke         → CloudKeyView

export interface BranchView {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  createdAt: number;
  hubs: Array<{ id: string; name: string; lastSeenAt: number | null }>;
  /** billiards / cafe; absent from an older cloud (= billiards). */
  businessType?: BusinessType;
}

export interface CreateBranchRequest {
  name: string;
  timezone?: string;
  currency?: string;
}

export interface CreateBranchResponse {
  branch: BranchView;
  /** Connect the branch's HUB with these: HUB_ID and CLOUD_API_KEY (the key is shown once). */
  hubId: string;
  hubApiKey: string;
}

export interface CloudKeyView {
  id: string;
  kind: KeyKind;
  prefix: string;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface CloudStaffView {
  id: string;
  clubId: string;
  name: string;
  roles: Role[];
  isActive: boolean;
  keys: CloudKeyView[];
  createdAt: number;
}

export interface CreateCloudStaffRequest {
  clubId: string;
  name: string;
  /** Staff roles only (STAFF_ROLES), any combination. */
  roles: Role[];
}

export interface UpdateCloudStaffRequest {
  name?: string;
  roles?: Role[];
  isActive?: boolean;
}

export interface IssueCloudKeyRequest {
  label?: string;
  expiresInDays?: number;
  /** Six digits picked by the manager; random when omitted. 422 KEY_WEAK, 409 KEY_TAKEN (unique within the branch). */
  key?: string;
}

export interface IssueCloudKeyResponse {
  /** Shown once. */
  key: string;
  view: CloudKeyView;
}

// ---------------------------------------------------------------------------
// Self sign-up and the first steps (Supabase Edge Functions `signup` and `owner`)
// ---------------------------------------------------------------------------
//
//   POST /functions/v1/signup                        SignupRequest → 201 SignupResponse (no JWT)
//        errors {error:{code,message}}: 400 BAD_REQUEST, 422 INVALID_EMAIL / WEAK_PASSWORD / NAME_REQUIRED /
//        INVALID_BUSINESS_TYPE / INVALID_TIMEZONE, 409 EMAIL_TAKEN, 429 RATE_LIMITED, 403 SIGNUP_DISABLED,
//        503 AUTH_ADMIN_OFF (functions without SUPABASE_SERVICE_ROLE_KEY)
//   POST /owner/clubs/:clubId/hub-code               → HubCodeResponse (new HUB key: the old one stops working)
//   POST /owner/clubs/:clubId/business               SetBusinessTypeRequest → BranchView
//   GET  /owner/onboarding                           → OnboardingResponse

export interface SignupRequest {
  email: string;
  /** At least 8 characters. */
  password: string;
  /** The venue: the company, its first branch and the licence get this name. */
  venueName: string;
  businessType: BusinessType;
  /** IANA time zone of the venue; Asia/Almaty when empty. */
  timezone?: string;
  /** Name of the first staff member (role manager); «Управляющий» when empty. */
  ownerName?: string;
}

export interface SignupResponse {
  ok: true;
  companyId: string;
  clubId: string;
  hubId: string;
  /** Six-digit key of the first staff member (role manager) for the venue screens; shown once. */
  managerKey: string;
  /** Length of the trial licence (14) and its end, ms since epoch. */
  trialDays: number;
  trialUntil: number;
}

export interface HubCodeResponse {
  hubId: string;
  /** CLOUD_API_KEY of the HUB; shown once, the previous key stops working. */
  apiKey: string;
  /** CLOUD_URL: `${SUPABASE_URL}/functions/v1`. */
  cloudUrl: string;
  /** encodeHubSetupCode({ hubId, apiKey, cloudUrl }): `TS1.…`. */
  code: string;
}

export interface SetBusinessTypeRequest {
  type: BusinessType;
}

export interface OnboardingClub {
  clubId: string;
  name: string;
  businessType: BusinessType;
  /** The oldest HUB of the branch (the one a connection code is for); null without one. */
  hubId: string | null;
  /** A HUB of the branch has reached the cloud at least once. */
  hubConnected: boolean;
  lastSeenAt: number | null;
  /** Active staff of the branch in the cabinet. */
  staff: number;
  /** Tariffs the HUB reported (or the manager edited in the cabinet). */
  tariffs: number;
  /** Shifts ever opened (as the HUB reported them). */
  shifts: number;
  /** Menu items: the cloud keeps no menu yet — always null. */
  menu: number | null;
}

export interface OnboardingResponse {
  clubs: OnboardingClub[];
}
