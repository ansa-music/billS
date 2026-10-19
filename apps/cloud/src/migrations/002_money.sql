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
