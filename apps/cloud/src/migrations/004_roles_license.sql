-- Roles and licenses. Portable SQL: runs unchanged on SQLite and PostgreSQL (see 001_init.sql).
--
-- Who is who in the cloud:
--  - the platform (the owner of TS and the support team) signs in with long keys OWNER-… / TECH-…
--    and manages clients: platform_staff, platform_keys, platform_sessions;
--  - a client is a company; its `owners` rows (the name is historical) are the client's MANAGERS:
--    cabinet e-mail + password, phone keys (owner_keys) and long MGR-… keys for the HUBs (manager_keys);
--  - the staff a manager hires in a branch (club_staff) sign in on that branch's HUB with
--    six-digit keys (club_keys) hashed together with the club id.

CREATE TABLE IF NOT EXISTS platform_staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'tech')),
  email TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

-- Long keys of the platform, sha256 of the canonical key.
CREATE TABLE IF NOT EXISTS platform_keys (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES platform_staff(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_platform_keys_staff ON platform_keys (staff_id);

-- Platform cabinet sessions; the token itself is never stored, only its sha256.
CREATE TABLE IF NOT EXISTS platform_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES platform_staff(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_platform_sessions_expires ON platform_sessions (expires_at);

-- Every signed license of a client; the one in force is the highest seq of the company.
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  signed TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  issued_by TEXT,
  UNIQUE (company_id, seq)
);

-- Blocked by the platform; access_version grows with every change of the access package
-- (license, managers, platform keys); a club adds its own version for its staff and keys.
ALTER TABLE companies ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN blocked_reason TEXT;
ALTER TABLE companies ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clubs ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;

-- Staff of one branch with a set of roles (JSON array of STAFF_ROLES).
CREATE TABLE IF NOT EXISTS club_staff (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  roles TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_club_staff_club ON club_staff (club_id);

-- Keys of branch staff. A short key's hash is sha256(shortKeyHashInput(club_id, digits)):
-- unique within the branch, meaningless in any other.
CREATE TABLE IF NOT EXISTS club_keys (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES club_staff(id),
  club_id TEXT NOT NULL REFERENCES clubs(id),
  kind TEXT NOT NULL CHECK (kind IN ('long', 'short')),
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  label TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  UNIQUE (club_id, key_hash)
);
CREATE INDEX IF NOT EXISTS ix_club_keys_staff ON club_keys (staff_id);

-- Managers' long keys MGR-… (every HUB of the company; also the phone / cabinet key sign-in).
CREATE TABLE IF NOT EXISTS manager_keys (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_manager_keys_owner ON manager_keys (owner_id);
