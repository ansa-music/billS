-- Access keys and sessions: how staff sign in. The key itself is shown once at
-- issue time; only its hash is stored. A session token is handed out at login
-- and sent as "Authorization: Bearer …"; it too is stored hashed.

CREATE TABLE access_keys (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  key_hash TEXT NOT NULL UNIQUE,   -- sha256 hex of the canonical key
  prefix TEXT NOT NULL,            -- "OWNER-7K3Q": shown in lists
  label TEXT,                      -- "планшет у бара"
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,        -- staff name or 'system'
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  last_used_at INTEGER
);
CREATE INDEX ix_access_keys_staff ON access_keys (staff_id, revoked_at);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  key_id TEXT NOT NULL REFERENCES access_keys(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device TEXT,
  revoked_at INTEGER
);
CREATE INDEX ix_auth_sessions_staff ON auth_sessions (staff_id, revoked_at);
