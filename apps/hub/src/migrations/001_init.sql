-- Company → clubs → tables. A HUB serves one club, but every row carries
-- club_id so the cloud can merge data from all clubs of a company.

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE clubs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tariffs (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  config TEXT NOT NULL, -- JSON TariffConfig (packages/domain)
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE billiard_tables (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pool', 'russian', 'snooker')),
  lamp_channel TEXT NOT NULL,
  default_tariff_id TEXT NOT NULL REFERENCES tariffs(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (club_id, lamp_channel)
);

-- One game on one table. Money in minor units.
CREATE TABLE table_sessions (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  table_id TEXT NOT NULL REFERENCES billiard_tables(id),
  tariff_id TEXT NOT NULL REFERENCES tariffs(id),
  tariff_name TEXT NOT NULL,
  tariff_snapshot TEXT NOT NULL, -- tariff config at open time: later edits do not reprice the game
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPENING', 'ACTIVE', 'AWAITING_PAYMENT', 'CLOSED', 'CANCELLED', 'FAILED')),
  requested_at INTEGER NOT NULL,
  started_at INTEGER,  -- lamp confirmed ON: billing starts
  stopped_at INTEGER,  -- Stop pressed: billing ends
  played_seconds INTEGER,
  billed_seconds INTEGER,
  amount INTEGER,
  failure_reason TEXT,
  opened_by TEXT NOT NULL,
  stopped_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_table_sessions_live ON table_sessions (table_id) WHERE status IN ('OPENING', 'ACTIVE');
CREATE INDEX ix_table_sessions_status ON table_sessions (status);

CREATE TABLE lamp_states (
  table_id TEXT PRIMARY KEY REFERENCES billiard_tables(id),
  desired TEXT NOT NULL CHECK (desired IN ('ON', 'OFF')),
  reported TEXT NOT NULL CHECK (reported IN ('ON', 'OFF', 'UNKNOWN')),
  reported_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Every command sent to a lamp controller. A newer command for the same
-- table supersedes a pending one.
CREATE TABLE lamp_commands (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES billiard_tables(id),
  session_id TEXT REFERENCES table_sessions(id),
  action TEXT NOT NULL CHECK (action IN ('ON', 'OFF')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACKED', 'FAILED', 'SUPERSEDED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX ix_lamp_commands_status ON lamp_commands (status, created_at);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  table_id TEXT REFERENCES billiard_tables(id),
  session_id TEXT REFERENCES table_sessions(id),
  message TEXT NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX ix_alerts_open ON alerts (resolved_at, at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Events waiting to be delivered to the cloud (stage 6).
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivered_at INTEGER
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
