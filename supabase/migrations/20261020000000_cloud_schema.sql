-- TS cloud schema for Supabase: the same portable SQL as apps/cloud/src/migrations/001–003,
-- concatenated in order (supabase/tests/schema.test.ts keeps them identical).
-- Supabase specifics (owner sign-in through Supabase Auth, RLS, report functions,
-- Realtime, push) come in the following migrations.

-- ===== apps/cloud/src/migrations/001_init.sql =====
-- Cloud schema. Portable SQL: runs unchanged on SQLite and PostgreSQL.
-- ids are TEXT (UUID), time is BIGINT (ms since epoch), booleans INTEGER 0/1, JSON is TEXT.

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS clubs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_clubs_company ON clubs (company_id);

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_sessions (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_owner_sessions_expires ON owner_sessions (expires_at);

-- One HUB serves one club. The API key is stored as a sha256 hex digest.
CREATE TABLE IF NOT EXISTS hubs (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  last_outbox_id BIGINT,
  settings_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_hubs_club ON hubs (club_id);

-- Current settings of a club: reported by the HUB (snapshot) or edited by the owner.
CREATE TABLE IF NOT EXISTS club_settings (
  club_id TEXT PRIMARY KEY REFERENCES clubs(id),
  version INTEGER NOT NULL DEFAULT 0,
  club_json TEXT NOT NULL,
  tariffs_json TEXT NOT NULL,
  tables_json TEXT NOT NULL,
  staff_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('hub', 'owner'))
);

-- Raw journal from every HUB. (hub_id, outbox_id) makes redelivery harmless.
CREATE TABLE IF NOT EXISTS events (
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  outbox_id BIGINT NOT NULL,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  at BIGINT NOT NULL,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  PRIMARY KEY (hub_id, outbox_id)
);
CREATE INDEX IF NOT EXISTS ix_events_club_at ON events (club_id, at);

-- Projection of session.* events.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  table_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPENING', 'ACTIVE', 'AWAITING_PAYMENT', 'CLOSED', 'CANCELLED', 'FAILED')),
  tariff_id TEXT,
  tariff_name TEXT,
  opened_by TEXT NOT NULL,
  stopped_by TEXT,
  requested_at BIGINT NOT NULL,
  started_at BIGINT,
  stopped_at BIGINT,
  played_seconds INTEGER,
  billed_seconds INTEGER,
  amount BIGINT,
  failure_reason TEXT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_club_requested ON sessions (club_id, requested_at);
CREATE INDEX IF NOT EXISTS ix_sessions_club_stopped ON sessions (club_id, stopped_at);
CREATE INDEX IF NOT EXISTS ix_sessions_live ON sessions (club_id) WHERE status IN ('OPENING', 'ACTIVE');

-- Projection of alert.* events.
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  at BIGINT NOT NULL,
  kind TEXT NOT NULL,
  table_id TEXT,
  session_id TEXT,
  message TEXT NOT NULL,
  resolved_at BIGINT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_alerts_club_at ON alerts (club_id, at);
CREATE INDEX IF NOT EXISTS ix_alerts_open ON alerts (club_id, at) WHERE resolved_at IS NULL;

-- Per local calendar day of the club. Revenue is what stopped games were billed.
CREATE TABLE IF NOT EXISTS daily_stats (
  club_id TEXT NOT NULL REFERENCES clubs(id),
  day TEXT NOT NULL,
  revenue BIGINT NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  played_seconds BIGINT NOT NULL DEFAULT 0,
  alerts INTEGER NOT NULL DEFAULT 0,
  lamp_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (club_id, day)
);

-- ===== apps/cloud/src/migrations/002_money.sql =====
-- Stage 6b: money (checks, payments, shifts), pauses and power outages in the cloud.
-- Portable SQL: runs unchanged on SQLite and PostgreSQL (see 001_init.sql for the rules).

-- sessions: PAUSED status and the pause/check/void columns. SQLite cannot change a CHECK
-- constraint in place, so the table is rebuilt; indexes go away with the old table.
CREATE TABLE IF NOT EXISTS sessions_v2 (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  table_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPENING', 'ACTIVE', 'PAUSED', 'AWAITING_PAYMENT', 'CLOSED', 'CANCELLED', 'FAILED')),
  tariff_id TEXT,
  tariff_name TEXT,
  opened_by TEXT NOT NULL,
  stopped_by TEXT,
  requested_at BIGINT NOT NULL,
  started_at BIGINT,
  stopped_at BIGINT,
  played_seconds INTEGER,
  billed_seconds INTEGER,
  amount BIGINT,
  failure_reason TEXT,
  paused_seconds INTEGER,
  check_id TEXT,
  paid_at BIGINT,
  cancel_reason TEXT,
  cancel_approved_by TEXT,
  prepaid_minutes INTEGER,
  pause_started_at BIGINT,
  pause_reason TEXT,
  updated_at BIGINT NOT NULL
);
INSERT INTO sessions_v2 (id, club_id, table_id, status, tariff_id, tariff_name, opened_by, stopped_by, requested_at,
                         started_at, stopped_at, played_seconds, billed_seconds, amount, failure_reason, updated_at)
SELECT id, club_id, table_id, status, tariff_id, tariff_name, opened_by, stopped_by, requested_at,
       started_at, stopped_at, played_seconds, billed_seconds, amount, failure_reason, updated_at
FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;
CREATE INDEX IF NOT EXISTS ix_sessions_club_requested ON sessions (club_id, requested_at);
CREATE INDEX IF NOT EXISTS ix_sessions_club_stopped ON sessions (club_id, stopped_at);
CREATE INDEX IF NOT EXISTS ix_sessions_live ON sessions (club_id) WHERE status IN ('OPENING', 'ACTIVE', 'PAUSED');
CREATE INDEX IF NOT EXISTS ix_sessions_check ON sessions (check_id);

-- daily_stats: money by the local day of the payment. `revenue` keeps its name but means
-- "billed on stop" (reports expose it as `billed`); revenue = paid_total - refunded.
ALTER TABLE daily_stats ADD COLUMN paid_total BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN paid_cash BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN paid_card BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN paid_qr BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN refunded BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN checks_paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN discounts BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN cancelled_games INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN power_outages INTEGER NOT NULL DEFAULT 0;

-- Projection of check.* and payment.* events (id = HUB check id).
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  number INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'PAID', 'VOID')),
  created_at BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  closed_at BIGINT,
  shift_id TEXT,
  subtotal BIGINT NOT NULL DEFAULT 0,
  discount BIGINT NOT NULL DEFAULT 0,
  discount_reason TEXT,
  total BIGINT NOT NULL DEFAULT 0,
  paid BIGINT NOT NULL DEFAULT 0,
  refunded BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_checks_club_created ON checks (club_id, created_at);
CREATE INDEX IF NOT EXISTS ix_checks_shift ON checks (shift_id);

-- One row per payment part / refund. id = hub:outbox[:part] so a replay cannot double it.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  check_id TEXT NOT NULL,
  shift_id TEXT,
  operation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('PAYMENT', 'REFUND')),
  method TEXT NOT NULL,
  amount BIGINT NOT NULL,
  at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_payments_club_at ON payments (club_id, at);
CREATE INDEX IF NOT EXISTS ix_payments_shift ON payments (shift_id);
CREATE INDEX IF NOT EXISTS ix_payments_check ON payments (check_id);

-- Cash shifts; net_* is the HUB's Z report, filled at shift.closed.
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  number INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at BIGINT NOT NULL,
  opened_by TEXT NOT NULL,
  opening_float BIGINT NOT NULL DEFAULT 0,
  closed_at BIGINT,
  closed_by TEXT,
  expected_cash BIGINT,
  counted_cash BIGINT,
  difference BIGINT,
  note TEXT,
  net_total BIGINT,
  net_cash BIGINT,
  net_card BIGINT,
  net_qr BIGINT
);
CREATE INDEX IF NOT EXISTS ix_shifts_club_opened ON shifts (club_id, opened_at);
CREATE INDEX IF NOT EXISTS ix_shifts_club_closed ON shifts (club_id, closed_at);

CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT', 'WITHDRAWAL')),
  amount BIGINT NOT NULL,
  reason TEXT,
  at BIGINT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cash_movements_shift ON cash_movements (shift_id);

-- One row per mains outage reported by the HUB's UPS monitor (id = hub:outbox of power.on_battery).
CREATE TABLE IF NOT EXISTS power_outages (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  critical INTEGER NOT NULL DEFAULT 0,
  paused_games INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_power_outages_club_started ON power_outages (club_id, started_at);

-- ===== apps/cloud/src/migrations/003_push.sql =====
-- Phase 3: the owner's phone app. Device tokens, notification rules, the push queue,
-- owner keys for sign-in by QR and bearer sessions for the app.

-- One row per phone (FCM registration token). A token moves to the owner who registered it last.
CREATE TABLE IF NOT EXISTS owner_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS ix_owner_devices_owner ON owner_devices (owner_id);

-- A kind switched on or off for one owner; club_id '' means all clubs, a club id overrides it.
CREATE TABLE IF NOT EXISTS push_rules (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  club_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (owner_id, club_id, kind)
);

-- Durable queue: written in the same transaction as the alert, sent after commit.
-- dedupe_key makes a redelivered event or a second watchdog pass harmless.
CREATE TABLE IF NOT EXISTS push_queue (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  kind TEXT NOT NULL,
  alert_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'SKIPPED', 'DISABLED', 'STALE')),
  sent_at BIGINT,
  delivered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_push_queue_status ON push_queue (status, created_at);

-- Owner keys (OWNER-…) for signing in on the phone: shown once as a QR in the cabinet, kept as sha256.
CREATE TABLE IF NOT EXISTS owner_keys (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_owner_keys_owner ON owner_keys (owner_id);

-- Watchdogs: once per episode. Cleared when the HUB is heard again.
ALTER TABLE hubs ADD COLUMN offline_alerted_at BIGINT;
ALTER TABLE shifts ADD COLUMN open_alerted_at BIGINT;
