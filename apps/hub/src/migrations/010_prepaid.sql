-- Prepaid ("for N minutes") games. The lamp warning blink needs nothing here:
-- BLINK commands (action, times) exist in lamp_commands since migration 006.

-- One row per game opened for a fixed time. The deadline is lamp-confirmed
-- start + minutes + unpaid pause time; it is stored once the game starts and
-- shifted when a pause closes, so a restart never loses it.
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
