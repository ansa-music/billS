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
