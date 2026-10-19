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
