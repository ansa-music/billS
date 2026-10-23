-- Bar orders join guest checks: every line of an order becomes an ORDER line of
-- the check, and the order is CLOSED once that check is paid.

-- SQLite cannot change a CHECK constraint in place: rebuild bar_orders with
-- the CLOSED status and the check the order is billed on.
--
-- Its child bar_order_items is rebuilt with it (fixed 2026-10: the first version
-- dropped bar_orders while order lines still pointed at it; with foreign_keys = ON
-- that leaves deferred violations a rename does not clear, so a database that
-- already had bar orders could not upgrade). New tables are filled parents first,
-- old ones dropped children first, then renamed (a rename rewrites the references).
-- Databases where the first version succeeded never run this file again.
CREATE TABLE bar_orders_new (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  session_id TEXT NOT NULL REFERENCES table_sessions(id),
  table_id TEXT NOT NULL REFERENCES billiard_tables(id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  note TEXT,
  total INTEGER NOT NULL CHECK (total >= 0),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT,
  updated_at INTEGER NOT NULL,
  check_id TEXT REFERENCES checks(id), -- the guest check it is billed on
  closed_at INTEGER                     -- that check was paid
);
INSERT INTO bar_orders_new
  (id, club_id, session_id, table_id, status, note, total, created_at, created_by,
   cancelled_at, cancelled_by, cancel_reason, updated_at)
  SELECT id, club_id, session_id, table_id, status, note, total, created_at, created_by,
         cancelled_at, cancelled_by, cancel_reason, updated_at
  FROM bar_orders;

CREATE TABLE bar_order_items_new (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES bar_orders_new(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL,   -- snapshot
  price INTEGER NOT NULL CHECK (price >= 0), -- snapshot
  qty INTEGER NOT NULL CHECK (qty > 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL
);
INSERT INTO bar_order_items_new (id, order_id, product_id, title, price, qty, amount, created_at)
  SELECT id, order_id, product_id, title, price, qty, amount, created_at FROM bar_order_items;

DROP TABLE bar_order_items;
DROP TABLE bar_orders;
ALTER TABLE bar_orders_new RENAME TO bar_orders;
ALTER TABLE bar_order_items_new RENAME TO bar_order_items;
CREATE INDEX ix_bar_orders_session ON bar_orders (session_id, status);
CREATE INDEX ix_bar_orders_check ON bar_orders (check_id);
CREATE INDEX ix_bar_order_items_order ON bar_order_items (order_id);

-- ORDER lines of a check: one per order line, with quantity and unit price snapshots.
ALTER TABLE check_items ADD COLUMN order_id TEXT REFERENCES bar_orders(id);
ALTER TABLE check_items ADD COLUMN order_item_id TEXT REFERENCES bar_order_items(id);
ALTER TABLE check_items ADD COLUMN qty INTEGER;
ALTER TABLE check_items ADD COLUMN unit_price INTEGER;
-- An order line is billed on one check at most.
CREATE UNIQUE INDEX ux_check_items_order_item ON check_items (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX ix_check_items_order ON check_items (order_id);
