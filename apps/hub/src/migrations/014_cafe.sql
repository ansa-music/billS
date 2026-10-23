-- Coffee shop mode (packages/domain cafe.ts): product options and counter orders.

-- Option groups of a product (size, milk, syrup): JSON array of ProductOptionGroup.
ALTER TABLE products ADD COLUMN options TEXT NOT NULL DEFAULT '[]';

-- What the guest chose, as a snapshot next to the line title: JSON array of choice names.
ALTER TABLE bar_order_items ADD COLUMN option_names TEXT;

-- bar_order_items and check_items reference bar_orders: let the rebuild below finish
-- before foreign keys are checked (at commit, when the ids are all back).
PRAGMA defer_foreign_keys = ON;

-- A counter order has no game and no table: session_id and table_id become NULLable,
-- so the table is rebuilt (SQLite cannot drop NOT NULL or add a CHECK in place).
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
DROP TABLE bar_orders;
ALTER TABLE bar_orders_new RENAME TO bar_orders;
CREATE INDEX ix_bar_orders_session ON bar_orders (session_id, status);
CREATE INDEX ix_bar_orders_check ON bar_orders (check_id);
CREATE INDEX ix_bar_orders_counter ON bar_orders (club_id, business_day, stage) WHERE counter_number IS NOT NULL;
-- Two orders on the guest screen never share a number: unique among those not yet handed over.
CREATE UNIQUE INDEX ux_bar_orders_counter_live ON bar_orders (club_id, business_day, counter_number)
  WHERE counter_number IS NOT NULL AND stage <> 'ISSUED' AND status <> 'CANCELLED';
