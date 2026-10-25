-- «Страница гостя по QR» (packages/domain guest.ts, apps/hub/src/guest.ts).

-- Off by default: the manager switches it on in «Настройки» → «QR для гостей».
CREATE TABLE guest_settings (
  club_id TEXT PRIMARY KEY REFERENCES clubs(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- The secret in a QR sticker: one per billiard table, or one for the counter of a coffee
-- shop (table_id NULL). Rotating replaces the token, so old stickers stop working.
CREATE TABLE guest_links (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  table_id TEXT REFERENCES billiard_tables(id),
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE UNIQUE INDEX guest_links_table ON guest_links(club_id, table_id) WHERE table_id IS NOT NULL;
CREATE UNIQUE INDEX guest_links_counter ON guest_links(club_id) WHERE table_id IS NULL;

-- What a guest asked for. Never money: staff accept a request and the usual service makes
-- the order (order_id), or reject it.
CREATE TABLE guest_requests (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  link_id TEXT NOT NULL REFERENCES guest_links(id),
  table_id TEXT REFERENCES billiard_tables(id),
  session_id TEXT REFERENCES table_sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('WAITER', 'BAR', 'EXTEND', 'BILL', 'PREORDER')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  minutes INTEGER,
  items TEXT NOT NULL DEFAULT '[]',       -- JSON: CounterLineInput[] as sent
  lines TEXT NOT NULL DEFAULT '[]',       -- JSON: GuestRequestLine[] priced at the request
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  guest_name TEXT,
  note TEXT,
  client_key TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT,
  reject_reason TEXT,
  order_id TEXT REFERENCES bar_orders(id)
);
CREATE INDEX guest_requests_pending ON guest_requests(club_id, status, created_at);
CREATE INDEX guest_requests_link ON guest_requests(link_id, created_at);
CREATE UNIQUE INDEX guest_requests_client_key ON guest_requests(link_id, client_key) WHERE client_key IS NOT NULL;
