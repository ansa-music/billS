-- «Лояльность без приложения» (packages/domain loyalty.ts): guests by phone, a ledger of
-- bonus / stamp moves, and the loyalty side of a check. Only new tables: nothing is rebuilt.
-- A reward is a discount on the check (checks.discount_*, reason «Лояльность: …»), so payments,
-- shifts and X/Z reports are unchanged.

-- A guest is created when their first order is paid. The owner needs the number, so it is
-- stored as is (+7XXXXXXXXXX); screens other than the manager's show it masked.
CREATE TABLE loyalty_guests (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  phone TEXT NOT NULL,
  name TEXT,
  visits INTEGER NOT NULL DEFAULT 0 CHECK (visits >= 0),
  last_visit_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_loyalty_guests_phone ON loyalty_guests (club_id, phone);

-- Every change of a guest's bonuses (minor units) and stamps, signed. Balances are sums
-- (bonuses with expiry: oldest lot first, see bonusBalance).
--   ACCRUE  — earned on a paid check;      REDEEM — spent on a paid check;
--   REVERSE — earned ones taken back on a refund; RETURN — spent ones given back on a refund;
--   ADJUST  — by the manager, with a reason.
CREATE TABLE loyalty_moves (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  guest_id TEXT NOT NULL REFERENCES loyalty_guests(id),
  check_id TEXT REFERENCES checks(id),
  kind TEXT NOT NULL CHECK (kind IN ('ACCRUE', 'REDEEM', 'REVERSE', 'RETURN', 'ADJUST')),
  bonus INTEGER NOT NULL DEFAULT 0,
  stamps INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX ix_loyalty_moves_guest ON loyalty_moves (guest_id, at);
CREATE INDEX ix_loyalty_moves_check ON loyalty_moves (check_id);

-- The guest of a check and what the check takes from / gives to them.
--   OPEN — attached, not paid yet (redeem_* are held, not spent);
--   PAID — settled: REDEEM and ACCRUE moves written; REVERSED — fully refunded.
-- A row of a check that became VOID is simply ignored.
CREATE TABLE loyalty_checks (
  check_id TEXT PRIMARY KEY REFERENCES checks(id),
  club_id TEXT NOT NULL REFERENCES clubs(id),
  phone TEXT NOT NULL,
  name TEXT,
  guest_id TEXT REFERENCES loyalty_guests(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAID', 'REVERSED')),
  kind TEXT CHECK (kind IN ('BONUS', 'FREE')),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  redeem_bonus INTEGER NOT NULL DEFAULT 0 CHECK (redeem_bonus >= 0),
  redeem_stamps INTEGER NOT NULL DEFAULT 0 CHECK (redeem_stamps >= 0),
  free_units INTEGER NOT NULL DEFAULT 0 CHECK (free_units >= 0),
  program TEXT,
  cashback_percent INTEGER,
  accrued_bonus INTEGER NOT NULL DEFAULT 0,
  accrued_stamps INTEGER NOT NULL DEFAULT 0,
  attached_at INTEGER NOT NULL,
  attached_by TEXT NOT NULL,
  paid_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_loyalty_checks_phone ON loyalty_checks (club_id, phone, status);
