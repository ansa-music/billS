-- «Склад», client feedback from a café on the trial (apps/hub/src/stock.ts):
--  * a delivery typed in by mistake is deleted or corrected — its stock goes back by counter-movements
--    (`supply_undo`, `supply_fix`), the delivery stays in the list marked deleted or corrected;
--  * a level is put right by hand with a reason (`adjust`), without a full inventory count;
--  * the example TS put in (stock-sample.ts) is marked, so the owner can remove it at once.

-- Who entered a delivery (staff id: they may change it themselves for a while), and its fate.
ALTER TABLE supplies ADD COLUMN created_by_id TEXT;
ALTER TABLE supplies ADD COLUMN deleted_at INTEGER;
ALTER TABLE supplies ADD COLUMN deleted_by TEXT;
ALTER TABLE supplies ADD COLUMN delete_reason TEXT;
ALTER TABLE supplies ADD COLUMN changed_at INTEGER;
ALTER TABLE supplies ADD COLUMN changed_by TEXT;

-- The ingredient's cost per unit just before this line came (deleting the latest delivery restores
-- it exactly). has_cost_before = 0 for lines written before this migration: the cost is unknown.
ALTER TABLE supply_lines ADD COLUMN cost_before INTEGER;
ALTER TABLE supply_lines ADD COLUMN has_cost_before INTEGER NOT NULL DEFAULT 0;

-- The trial's sample stock: ingredients and recipe lines TS put in. A recipe the owner saves is theirs.
ALTER TABLE ingredients ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipe_items ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;

-- New kinds of movement: the CHECK cannot change in place, so the log is rebuilt. Nothing refers
-- to stock_movements, so it is a plain copy (ids, and so the order of the log, are kept).
CREATE TABLE stock_movements_new (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'sale', 'return', 'supply', 'supply_undo', 'supply_fix', 'inventory', 'adjust', 'writeoff')),
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
INSERT INTO stock_movements_new (id, at, ingredient_id, kind, quantity, balance, cost, order_id, product_id, supply_id, count_id, reason, actor)
  SELECT id, at, ingredient_id, kind, quantity, balance, cost, order_id, product_id, supply_id, count_id, reason, actor FROM stock_movements;
DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;
CREATE INDEX stock_movements_at ON stock_movements(at);
CREATE INDEX stock_movements_ingredient ON stock_movements(ingredient_id, at);
CREATE INDEX stock_movements_order ON stock_movements(order_id);
CREATE INDEX stock_movements_supply ON stock_movements(supply_id);

-- A trial that got the sample before this build: its rows are the sample names (stock-sample.ts
-- INGREDIENTS) created together, within seconds of the very first ingredient. A sample name the
-- owner typed later is theirs.
UPDATE ingredients SET is_sample = 1
WHERE name || '|' || unit IN (
    'Кофе в зёрнах|г', 'Молоко 3,2%|мл', 'Овсяное молоко|мл', 'Сахар|г', 'Сироп карамельный|мл',
    'Сироп ванильный|мл', 'Сироп ореховый|мл', 'Стакан 0,3|шт', 'Стакан 0,4|шт', 'Стакан 0,5|шт'
  )
  AND created_at <= (SELECT MIN(created_at) FROM ingredients) + 10000;

-- Sample recipes (the sample coffee menu) nobody has saved since: every line written with the
-- sample and made only of sample ingredients.
UPDATE recipe_items SET is_sample = 1
WHERE product_id IN (
  SELECT r.product_id FROM recipe_items r JOIN products p ON p.id = r.product_id
  WHERE p.name IN ('Эспрессо', 'Американо', 'Капучино', 'Латте', 'Раф', 'Флэт уайт')
  GROUP BY r.product_id
  HAVING MAX(r.updated_at) <= (SELECT MIN(created_at) FROM ingredients WHERE is_sample = 1) + 10000
    AND SUM(CASE WHEN r.ingredient_id IN (SELECT id FROM ingredients WHERE is_sample = 1) THEN 0 ELSE 1 END) = 0
    AND SUM(CASE WHEN r.replaces_id IS NULL OR r.replaces_id IN (SELECT id FROM ingredients WHERE is_sample = 1) THEN 0 ELSE 1 END) = 0
);
