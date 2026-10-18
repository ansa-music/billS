-- Pauses caused by a power cut (stage 5, UPS): reason 'power'. Never billed,
-- never counted against the tariff's pause budget, lamp off while paused.
-- SQLite cannot change a CHECK constraint, so session_pauses is rebuilt
-- (nothing references it; it only references table_sessions and billiard_tables).
CREATE TABLE session_pauses_v2 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES table_sessions(id),
  reason TEXT NOT NULL CHECK (reason IN ('pause', 'transfer', 'power')),
  paused_at INTEGER NOT NULL,
  resume_requested_at INTEGER,
  resumed_at INTEGER,
  paused_by TEXT NOT NULL,
  resumed_by TEXT,
  from_table_id TEXT REFERENCES billiard_tables(id),
  to_table_id TEXT REFERENCES billiard_tables(id)
);
INSERT INTO session_pauses_v2 SELECT id, session_id, reason, paused_at, resume_requested_at, resumed_at, paused_by, resumed_by, from_table_id, to_table_id FROM session_pauses;
DROP TABLE session_pauses;
ALTER TABLE session_pauses_v2 RENAME TO session_pauses;
CREATE UNIQUE INDEX ux_session_pauses_open ON session_pauses (session_id) WHERE resumed_at IS NULL;
CREATE INDEX ix_session_pauses_session ON session_pauses (session_id, paused_at);
