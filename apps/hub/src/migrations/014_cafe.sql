-- Coffee shop mode (packages/domain cafe.ts): product options and counter orders.

-- Option groups of a product (size, milk, syrup): JSON array of ProductOptionGroup.
ALTER TABLE products ADD COLUMN options TEXT NOT NULL DEFAULT '[]';

-- A counter order has no game and no table: bar_orders.session_id and table_id become
-- NULLable, so the table is rebuilt (SQLite cannot drop NOT NULL or add a CHECK in place).
--
-- Its children (bar_order_items, check_items) are rebuilt with it, the way 013 rebuilt
-- staff: with foreign_keys = ON, dropping a parent that still has child rows leaves
-- deferred violations that a later rename does not clear, and the commit fails. So the
-- new tables are created next to the old ones, filled parents first, the old ones
-- dropped children first, and the new ones renamed (a rename rewrites the references).

-- Either a game order (session and table set, no counter fields) or a counter order
-- (number of the working day, stage and service set, no game).
CREATE TABLE bar_orders_new (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  session_id TEXT REFERENCES table_sessions(id),
  table_id TEXT REFERENCES billiard_tables(id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  note TEXT,
  total INTEGER NOT NULL CHECK (total >= 0),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT,
  updated_at INTEGER NOT NULL,
  check_id TEXT REFERENCES checks(id),
  closed_at INTEGER,
  counter_number INTEGER CHECK (counter_number BETWEEN 1 AND 999), -- «Заказ 17», restarts every working day
  service TEXT CHECK (service IN ('HERE', 'TAKEAWAY')),
  stage TEXT CHECK (stage IN ('NEW', 'PREPARING', 'READY', 'ISSUED')),
  guest_name TEXT,
  ready_at INTEGER,
  issued_at INTEGER,
  business_day TEXT,                    -- club working day YYYY-MM-DD (starts 06:00 club time)
  CHECK (
    (session_id IS NOT NULL AND table_id IS NOT NULL
      AND counter_number IS NULL AND stage IS NULL AND service IS NULL AND business_day IS NULL)
    OR
    (session_id IS NULL AND table_id IS NULL
      AND counter_number IS NOT NULL AND stage IS NOT NULL AND service IS NOT NULL AND business_day IS NOT NULL)
  )
);
INSERT INTO bar_orders_new
  (id, club_id, session_id, table_id, status, note, total, created_at, created_by,
   cancelled_at, cancelled_by, cancel_reason, updated_at, check_id, closed_at)
  SELECT id, club_id, session_id, table_id, status, note, total, created_at, created_by,
         cancelled_at, cancelled_by, cancel_reason, updated_at, check_id, closed_at
  FROM bar_orders;

CREATE TABLE bar_order_items_new (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES bar_orders_new(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL,   -- snapshot: «Капучино · L · Овсяное»
  price INTEGER NOT NULL CHECK (price >= 0), -- snapshot, options included
  qty INTEGER NOT NULL CHECK (qty > 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL,
  option_names TEXT      -- snapshot: JSON array of the chosen option names; NULL = none
);
INSERT INTO bar_order_items_new (id, order_id, product_id, title, price, qty, amount, created_at)
  SELECT id, order_id, product_id, title, price, qty, amount, created_at FROM bar_order_items;

CREATE TABLE check_items_new (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES checks(id),
  kind TEXT NOT NULL CHECK (kind IN ('GAME', 'ORDER')),
  session_id TEXT REFERENCES table_sessions(id),
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL,
  order_id TEXT REFERENCES bar_orders_new(id),
  order_item_id TEXT REFERENCES bar_order_items_new(id),
  qty INTEGER,
  unit_price INTEGER,
  CHECK ((kind = 'GAME') = (session_id IS NOT NULL))
);
INSERT INTO check_items_new
  (id, check_id, kind, session_id, title, amount, created_at, order_id, order_item_id, qty, unit_price)
  SELECT id, check_id, kind, session_id, title, amount, created_at, order_id, order_item_id, qty, unit_price
  FROM check_items;

DROP TABLE check_items;
DROP TABLE bar_order_items;
DROP TABLE bar_orders;
ALTER TABLE bar_orders_new RENAME TO bar_orders;
ALTER TABLE bar_order_items_new RENAME TO bar_order_items;
ALTER TABLE check_items_new RENAME TO check_items;

CREATE INDEX ix_bar_orders_session ON bar_orders (session_id, status);
CREATE INDEX ix_bar_orders_check ON bar_orders (check_id);
CREATE INDEX ix_bar_orders_counter ON bar_orders (club_id, business_day, stage) WHERE counter_number IS NOT NULL;
-- Two orders on the guest screen never share a number: unique among those not yet handed over.
CREATE UNIQUE INDEX ux_bar_orders_counter_live ON bar_orders (club_id, business_day, counter_number)
  WHERE counter_number IS NOT NULL AND stage <> 'ISSUED' AND status <> 'CANCELLED';
CREATE INDEX ix_bar_order_items_order ON bar_order_items (order_id);
-- As before (002, 012): a game and an order line are billed on one check at most.
CREATE UNIQUE INDEX ux_check_items_session ON check_items (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ix_check_items_check ON check_items (check_id);
CREATE UNIQUE INDEX ux_check_items_order_item ON check_items (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX ix_check_items_order ON check_items (order_id);
