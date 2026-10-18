-- Stage 5: real hardware. Blink commands, current sensors, manual mode.

-- lamp_commands gets the BLINK action and a `times` column. SQLite cannot
-- change a CHECK constraint, so the table is rebuilt (nothing references it).
CREATE TABLE lamp_commands_v2 (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES billiard_tables(id),
  session_id TEXT REFERENCES table_sessions(id),
  action TEXT NOT NULL CHECK (action IN ('ON', 'OFF', 'BLINK')),
  times INTEGER,          -- BLINK only
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACKED', 'FAILED', 'SUPERSEDED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
INSERT INTO lamp_commands_v2 (id, table_id, session_id, action, times, status, attempts, last_error, created_at, finished_at)
  SELECT id, table_id, session_id, action, NULL, status, attempts, last_error, created_at, finished_at FROM lamp_commands;
DROP TABLE lamp_commands;
ALTER TABLE lamp_commands_v2 RENAME TO lamp_commands;
CREATE INDEX ix_lamp_commands_status ON lamp_commands (status, created_at);

-- What the periodic poll of the controller saw last.
ALTER TABLE lamp_states ADD COLUMN polled_on INTEGER;       -- relay closed: 1/0, NULL = never polled
ALTER TABLE lamp_states ADD COLUMN current_on INTEGER;      -- current flows: 1/0, NULL = no sensor / never polled
ALTER TABLE lamp_states ADD COLUMN polled_at INTEGER;

-- Games opened in manual mode: billing started at the button press, not at the lamp.
ALTER TABLE table_sessions ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;

-- Club-level switches of the HUB (manual mode, …). JSON values.
CREATE TABLE hub_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
