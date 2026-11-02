-- «Склад» of a coffee shop (packages/domain stock.ts, apps/hub/src/stock.ts): raw materials,
-- recipes (тех. карты), deliveries, inventory counts and a log of every stock movement.
-- Quantities are integer thousandths of the ingredient's unit (18,5 г = 18500); money is in
-- minor units. A stock level may go below zero: a sale is never blocked by it.

CREATE TABLE ingredients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('г', 'мл', 'шт')),
  quantity INTEGER NOT NULL DEFAULT 0,
  -- Minor units per one unit (1 г, 1 мл, 1 шт); NULL until known.
  cost_per_unit INTEGER CHECK (cost_per_unit IS NULL OR cost_per_unit >= 0),
  -- Warn below this level (thousandths); NULL = no warning.
  min_level INTEGER CHECK (min_level IS NULL OR min_level >= 0),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per ingredient of a product's recipe. choice_id NULL with mode 'base' is the plain
-- portion; a row with choice_id changes it when that option is chosen (add / set / swap).
CREATE TABLE recipe_items (
  id INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  choice_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('base', 'add', 'set', 'swap')),
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  replaces_id TEXT REFERENCES ingredients(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  sort_order INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((mode = 'base') = (choice_id IS NULL)),
  CHECK ((mode = 'swap') = (replaces_id IS NOT NULL))
);
CREATE INDEX recipe_items_product ON recipe_items(product_id);

CREATE TABLE supplies (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  supplier TEXT NOT NULL,
  note TEXT,
  total INTEGER NOT NULL CHECK (total >= 0),
  created_by TEXT NOT NULL
);
CREATE INDEX supplies_at ON supplies(at);

CREATE TABLE supply_lines (
  id INTEGER PRIMARY KEY,
  supply_id TEXT NOT NULL REFERENCES supplies(id),
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  amount INTEGER NOT NULL CHECK (amount >= 0)
);
CREATE INDEX supply_lines_supply ON supply_lines(supply_id);

CREATE TABLE stock_counts (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  note TEXT,
  -- Sum of the line costs: below 0 — a shortage.
  diff_cost INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX stock_counts_at ON stock_counts(at);

CREATE TABLE stock_count_lines (
  id INTEGER PRIMARY KEY,
  count_id TEXT NOT NULL REFERENCES stock_counts(id),
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  expected INTEGER NOT NULL,
  counted INTEGER NOT NULL CHECK (counted >= 0),
  difference INTEGER NOT NULL,
  -- The difference at cost; NULL when the cost was unknown.
  cost INTEGER
);
CREATE INDEX stock_count_lines_count ON stock_count_lines(count_id);

-- Every change of a stock level, one row per ingredient: sales and their cancellation,
-- deliveries, counts, write-offs. quantity is the signed change, balance the level after it.
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'sale', 'return', 'supply', 'inventory', 'writeoff')),
  quantity INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  cost INTEGER,
  order_id TEXT,
  product_id TEXT,
  supply_id TEXT,
  count_id TEXT,
  reason TEXT,
  actor TEXT NOT NULL
);
CREATE INDEX stock_movements_at ON stock_movements(at);
CREATE INDEX stock_movements_ingredient ON stock_movements(ingredient_id, at);
CREATE INDEX stock_movements_order ON stock_movements(order_id);
