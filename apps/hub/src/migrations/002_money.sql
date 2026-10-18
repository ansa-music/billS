-- Stage 2: guest checks, payments, cash shifts. Money in minor units.

-- One cash shift at a time per club: opened with change (float), closed with a count.
CREATE TABLE cash_shifts (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  opening_float INTEGER NOT NULL CHECK (opening_float >= 0),
  opened_at INTEGER NOT NULL,
  opened_by TEXT NOT NULL,
  closed_at INTEGER,
  closed_by TEXT,
  counted_cash INTEGER,
  expected_cash INTEGER,
  difference INTEGER,
  close_note TEXT,
  z_report TEXT, -- JSON ShiftReport fixed at close
  UNIQUE (club_id, number)
);
CREATE UNIQUE INDEX ux_cash_shifts_open ON cash_shifts (club_id) WHERE status = 'OPEN';

-- Cash put into or taken out of the drawer that is not a sale.
CREATE TABLE cash_movements (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES cash_shifts(id),
  kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT', 'WITHDRAWAL')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX ix_cash_movements_shift ON cash_movements (shift_id);

CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'PAID', 'VOID')),
  discount_kind TEXT CHECK (discount_kind IN ('PERCENT', 'AMOUNT')),
  discount_value INTEGER,
  discount_reason TEXT,
  discount_by TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  closed_at INTEGER,
  closed_shift_id TEXT REFERENCES cash_shifts(id), -- shift in which it was fully paid
  updated_at INTEGER NOT NULL,
  UNIQUE (club_id, number)
);
CREATE INDEX ix_checks_status ON checks (club_id, status);

-- Lines of a check: games now, bar orders from stage 4. Amounts are snapshots.
CREATE TABLE check_items (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES checks(id),
  kind TEXT NOT NULL CHECK (kind IN ('GAME', 'ORDER')),
  session_id TEXT REFERENCES table_sessions(id),
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'GAME') = (session_id IS NOT NULL))
);
-- A game is billed on one check at most.
CREATE UNIQUE INDEX ux_check_items_session ON check_items (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ix_check_items_check ON check_items (check_id);

-- Money in (PAYMENT) and back out (REFUND). Parts of a mixed payment share operation_id.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  check_id TEXT NOT NULL REFERENCES checks(id),
  shift_id TEXT NOT NULL REFERENCES cash_shifts(id),
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PAYMENT', 'REFUND')),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'CARD', 'QR')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  tendered INTEGER,
  change INTEGER,
  reason TEXT,
  approved_by TEXT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  CHECK (kind = 'PAYMENT' OR (reason IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE INDEX ix_payments_check ON payments (check_id);
CREATE INDEX ix_payments_shift ON payments (shift_id);

-- Voiding an unpaid game needs a reason and a manager.
ALTER TABLE table_sessions ADD COLUMN cancel_reason TEXT;
ALTER TABLE table_sessions ADD COLUMN cancel_approved_by TEXT;
ALTER TABLE table_sessions ADD COLUMN cancelled_by TEXT;
ALTER TABLE table_sessions ADD COLUMN cancelled_at INTEGER;
