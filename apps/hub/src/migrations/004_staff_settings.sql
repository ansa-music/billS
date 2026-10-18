-- Stage 3: staff of a club with roles and a hashed PIN; club settings JSON.

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'waiter', 'superadmin')),
  pin_hash TEXT,          -- "scrypt$<salt hex>$<hash hex>", NULL = no PIN yet
  is_active INTEGER NOT NULL DEFAULT 1,
  table_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of billiard_tables.id a waiter is assigned to
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_staff_club ON staff (club_id, is_active);

-- Hall screen look and house rules (packages/domain ClubSettings), JSON.
ALTER TABLE clubs ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
