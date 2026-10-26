-- «Продлить предоплаченную игру на N минут».
--
-- prepaid_games.minutes is the whole paid time (the deadline counts from it);
-- extended_minutes is the part of it added later, for the screens and the journal.
ALTER TABLE prepaid_games ADD COLUMN extended_minutes INTEGER NOT NULL DEFAULT 0 CHECK (extended_minutes >= 0);

-- A game paid upfront is extended on a check of its own: a line «Продление» (kind
-- EXTENSION) names the extended game in extends_session_id. session_id stays NULL, so a
-- game is still on one check at most (ux_check_items_session) and the joins on session_id
-- see only GAME lines. The kind CHECK needs a rebuild; nothing references check_items.
CREATE TABLE check_items_new (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES checks(id),
  kind TEXT NOT NULL CHECK (kind IN ('GAME', 'ORDER', 'EXTENSION')),
  session_id TEXT REFERENCES table_sessions(id),
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL,
  order_id TEXT REFERENCES bar_orders(id),
  order_item_id TEXT REFERENCES bar_order_items(id),
  qty INTEGER,
  unit_price INTEGER,
  extends_session_id TEXT REFERENCES table_sessions(id),
  minutes INTEGER CHECK (minutes IS NULL OR minutes > 0),
  CHECK ((kind = 'GAME') = (session_id IS NOT NULL)),
  CHECK ((kind = 'EXTENSION') = (extends_session_id IS NOT NULL AND minutes IS NOT NULL))
);
INSERT INTO check_items_new
  (id, check_id, kind, session_id, title, amount, created_at, order_id, order_item_id, qty, unit_price)
  SELECT id, check_id, kind, session_id, title, amount, created_at, order_id, order_item_id, qty, unit_price
  FROM check_items;
DROP TABLE check_items;
ALTER TABLE check_items_new RENAME TO check_items;

-- As before (002, 012, 014): a game and an order line are billed on one check at most.
CREATE UNIQUE INDEX ux_check_items_session ON check_items (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ix_check_items_check ON check_items (check_id);
CREATE UNIQUE INDEX ux_check_items_order_item ON check_items (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX ix_check_items_order ON check_items (order_id);
CREATE INDEX ix_check_items_extends ON check_items (extends_session_id) WHERE extends_session_id IS NOT NULL;
