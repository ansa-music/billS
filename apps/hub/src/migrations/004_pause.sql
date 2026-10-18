-- Pauses and transfers of a game.
--
-- A PAUSED game is stored as status ACTIVE plus an open row here (resumed_at IS NULL):
-- the status CHECK and the live-game unique index of table_sessions stay as they
-- are, and every "live" query keeps working. The API exposes the effective status.
CREATE TABLE session_pauses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES table_sessions(id),
  reason TEXT NOT NULL CHECK (reason IN ('pause', 'transfer')),
  paused_at INTEGER NOT NULL,          -- time and money stop here
  resume_requested_at INTEGER,         -- «Продолжить» pressed (or transfer requested): lamp ON on its way
  resumed_at INTEGER,                  -- lamp confirmed ON: time runs again (or the game was stopped)
  paused_by TEXT NOT NULL,
  resumed_by TEXT,
  from_table_id TEXT REFERENCES billiard_tables(id), -- transfer: where the game was
  to_table_id TEXT REFERENCES billiard_tables(id)    -- transfer: where it went
);
CREATE UNIQUE INDEX ux_session_pauses_open ON session_pauses (session_id) WHERE resumed_at IS NULL;
CREATE INDEX ix_session_pauses_session ON session_pauses (session_id, paused_at);

-- Unpaid pause time of a stopped game (staff pauses within the tariff budget + transfers).
ALTER TABLE table_sessions ADD COLUMN paused_seconds INTEGER;

-- A paused game may keep its lamp blinking (tariff pauseLamp = 'blink'): ON + blink.
ALTER TABLE lamp_commands ADD COLUMN blink INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lamp_states ADD COLUMN blink INTEGER NOT NULL DEFAULT 0;
