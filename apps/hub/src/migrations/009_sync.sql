-- Cloud sync (stage 6): one row of worker state, plus a fast path to the
-- undelivered tail of the outbox.

CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_version INTEGER NOT NULL DEFAULT 0, -- club settings version applied from the cloud
  settings_hash TEXT,                          -- sha256 of the last snapshot the cloud accepted
  last_sent_at INTEGER,                        -- last successful exchange with the cloud
  last_error TEXT,
  last_error_at INTEGER
);
INSERT INTO sync_state (id) VALUES (1);

CREATE INDEX ix_outbox_undelivered ON outbox (id) WHERE delivered_at IS NULL;
