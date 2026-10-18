-- Floor plan of the hall: where each table stands and landmarks (bar, entrance…).
-- One JSON document per club (HallLayout in packages/domain/src/hall.ts), saved as a whole.
CREATE TABLE hall_layouts (
  club_id TEXT PRIMARY KEY REFERENCES clubs(id),
  layout TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
