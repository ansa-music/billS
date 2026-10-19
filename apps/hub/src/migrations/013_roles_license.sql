-- Roles as sets, short branch keys, signed licenses (packages/domain permissions.ts, auth.ts, license.ts).
--
-- `staff` had a CHECK on the old single roles: the table is rebuilt. Its children
-- (access_keys, auth_sessions) are rebuilt with it — dropping a parent row set
-- under a running transaction with foreign_keys = ON would fail, so the new
-- tables are created next to the old ones, filled, the old ones dropped
-- children first, and the new ones renamed (a rename rewrites the references).
--
-- Old roles → new:
--   superadmin → tech (scope platform)
--   owner      → manager (scope company: the client)
--   manager    → admin + senior (the club's administrator)
--   cashier, waiter — unchanged.

CREATE TABLE staff_new (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,                       -- primaryRole(roles), for lists and old readers
  roles TEXT NOT NULL DEFAULT '[]',         -- JSON array of roles (packages/domain ROLES)
  origin TEXT NOT NULL DEFAULT 'hub' CHECK (origin IN ('hub', 'cloud')),
  scope TEXT NOT NULL DEFAULT 'club' CHECK (scope IN ('platform', 'company', 'club')),
  pin_hash TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  table_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO staff_new (id, club_id, name, role, roles, origin, scope, pin_hash, is_active, table_ids, created_at, updated_at)
SELECT
  id,
  club_id,
  name,
  CASE role WHEN 'superadmin' THEN 'tech' WHEN 'owner' THEN 'manager' WHEN 'manager' THEN 'admin' ELSE role END,
  CASE role
    WHEN 'superadmin' THEN '["tech"]'
    WHEN 'owner' THEN '["manager"]'
    WHEN 'manager' THEN '["admin","senior"]'
    ELSE '["' || role || '"]'
  END,
  'hub',
  CASE role WHEN 'superadmin' THEN 'platform' WHEN 'owner' THEN 'company' ELSE 'club' END,
  pin_hash,
  is_active,
  table_ids,
  created_at,
  updated_at
FROM staff;

CREATE TABLE access_keys_new (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  staff_id TEXT NOT NULL REFERENCES staff_new(id),
  kind TEXT NOT NULL DEFAULT 'long' CHECK (kind IN ('long', 'short')),
  origin TEXT NOT NULL DEFAULT 'hub' CHECK (origin IN ('hub', 'cloud')),
  -- long: sha256(key); short: sha256(shortKeyHashInput(clubId, key)) — the club id is
  -- part of the hash, so a hash copied from another branch never matches here.
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,            -- "MGR-7K3Q" or "••••42"
  label TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  last_used_at INTEGER
);

INSERT INTO access_keys_new (id, club_id, staff_id, kind, origin, key_hash, prefix, label, created_at, created_by, expires_at, revoked_at, revoked_by, last_used_at)
SELECT id, club_id, staff_id, 'long', 'hub', key_hash, prefix, label, created_at, created_by, expires_at, revoked_at, revoked_by, last_used_at
FROM access_keys;

CREATE TABLE auth_sessions_new (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff_new(id),
  key_id TEXT NOT NULL REFERENCES access_keys_new(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device TEXT,
  revoked_at INTEGER
);

INSERT INTO auth_sessions_new SELECT token_hash, staff_id, key_id, created_at, last_seen_at, expires_at, device, revoked_at FROM auth_sessions;

DROP TABLE auth_sessions;
DROP TABLE access_keys;
DROP TABLE staff;
ALTER TABLE staff_new RENAME TO staff;
ALTER TABLE access_keys_new RENAME TO access_keys;
ALTER TABLE auth_sessions_new RENAME TO auth_sessions;

CREATE INDEX ix_staff_club ON staff (club_id, is_active);
CREATE INDEX ix_access_keys_staff ON access_keys (staff_id, revoked_at);
CREATE INDEX ix_auth_sessions_staff ON auth_sessions (staff_id, revoked_at);

-- Every login attempt, good or bad. The key itself is never stored.
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  kind TEXT,                       -- 'long' | 'short' | NULL (neither shape)
  key_id TEXT,
  staff_id TEXT,
  prefix TEXT,
  device TEXT,
  ip TEXT,
  result TEXT NOT NULL             -- ok | wrong_key | revoked | expired | inactive | locked | branch_locked
);
CREATE INDEX ix_login_attempts_at ON login_attempts (at);

-- Brute-force throttle: consecutive failures per source (IP + device); the row
-- 'branch' holds the branch-wide pause of short keys.
CREATE TABLE login_throttle (
  source TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  locked_until INTEGER
);

-- The license in force: the signed text as received (checked on every start).
CREATE TABLE license_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  signed TEXT,
  source TEXT CHECK (source IN ('cloud', 'manual')),
  installed_at INTEGER,
  high_water INTEGER NOT NULL DEFAULT 0   -- the latest time this HUB has seen: winding the clock back does not help
);
INSERT INTO license_state (id, high_water) VALUES (1, 0);

-- Which access package (people, keys, license) from the cloud is applied.
CREATE TABLE access_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER,                 -- NULL: never applied
  cloud_club_id TEXT,              -- the cloud's id of this branch: cloud short keys are hashed over it
  applied_at INTEGER
);
INSERT INTO access_sync (id) VALUES (1);
