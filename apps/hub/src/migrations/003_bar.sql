-- Stage 4: bar catalog and orders on a game. Money in minor units.
-- An order is bound to a game (session). When a check is built for the game
-- (stage 2), its orders become ORDER lines of that check.

CREATE TABLE product_categories (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  category_id TEXT NOT NULL REFERENCES product_categories(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  stock INTEGER, -- NULL = not tracked
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_products_category ON products (category_id, sort_order);

CREATE TABLE bar_orders (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  session_id TEXT NOT NULL REFERENCES table_sessions(id),
  table_id TEXT NOT NULL REFERENCES billiard_tables(id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CANCELLED')),
  note TEXT,
  total INTEGER NOT NULL CHECK (total >= 0),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_bar_orders_session ON bar_orders (session_id, status);

CREATE TABLE bar_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES bar_orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL,   -- snapshot
  price INTEGER NOT NULL CHECK (price >= 0), -- snapshot
  qty INTEGER NOT NULL CHECK (qty > 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_bar_order_items_order ON bar_order_items (order_id);
