-- «Онлайн-бронь столов» (packages/domain booking.ts, apps/hub/src/bookings.ts).
-- Bookings come from the cloud (GET /sync/bookings, pulled when /sync/events reports a new
-- bookingsVersion) and stay here, so the hall keeps them without internet. The guest's arrival and
-- «не пришёл» are decided on the HUB (local_status) and go up as outbox events.

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  starts_at INTEGER NOT NULL,
  minutes INTEGER NOT NULL,
  -- NULL = «любой» стол
  table_kind TEXT CHECK (table_kind IS NULL OR table_kind IN ('pool', 'russian', 'snooker')),
  guest_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  -- What the cloud says: PENDING, CONFIRMED, CANCELLED (and ARRIVED / NO_SHOW echoed back).
  cloud_status TEXT NOT NULL,
  -- What the hall decided; wins over the cloud's status.
  local_status TEXT CHECK (local_status IS NULL OR local_status IN ('ARRIVED', 'NO_SHOW')),
  -- The table the guest got on arrival.
  table_id TEXT REFERENCES billiard_tables(id),
  arrived_at INTEGER,
  no_show_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX bookings_starts_at ON bookings(starts_at);

-- The bookings version this HUB applied and the club's switches from the cloud.
CREATE TABLE booking_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  hold_minutes INTEGER NOT NULL DEFAULT 15,
  applied_at INTEGER
);
INSERT INTO booking_sync (id) VALUES (1);
