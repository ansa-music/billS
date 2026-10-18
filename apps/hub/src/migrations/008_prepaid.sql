-- Prepaid ("for N minutes") games and the lamp warning blink.

-- One row per game opened for a fixed time. The deadline is lamp-confirmed
-- start + minutes; it is stored once the game starts, so a restart (or a
-- future pause, which shifts it) never loses it.
CREATE TABLE prepaid_games (
  session_id TEXT PRIMARY KEY REFERENCES table_sessions(id),
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  deadline_at INTEGER,
  amount INTEGER CHECK (amount IS NULL OR amount >= 0), -- paid upfront; NULL: paid after the stop
  check_id TEXT REFERENCES checks(id),
  warned_at INTEGER,  -- the 5-minute warning blink was queued
  ended_at INTEGER,   -- the HUB stopped the game at its deadline
  settled_at INTEGER, -- paid game closed after its stop, or alert raised when it never started
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_prepaid_games_open ON prepaid_games (settled_at, deadline_at);

-- Lamp commands gain BLINK (warning before the end of prepaid time).
-- SQLite cannot change a CHECK constraint in place: rebuild the table.
CREATE TABLE lamp_commands_new (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES billiard_tables(id),
  session_id TEXT REFERENCES table_sessions(id),
  action TEXT NOT NULL CHECK (action IN ('ON', 'OFF', 'BLINK')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACKED', 'FAILED', 'SUPERSEDED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
INSERT INTO lamp_commands_new (id, table_id, session_id, action, status, attempts, last_error, created_at, finished_at)
  SELECT id, table_id, session_id, action, status, attempts, last_error, created_at, finished_at FROM lamp_commands;
DROP TABLE lamp_commands;
ALTER TABLE lamp_commands_new RENAME TO lamp_commands;
CREATE INDEX ix_lamp_commands_status ON lamp_commands (status, created_at);
