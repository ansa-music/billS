-- What a branch is: billiards (tables, time, lamps) or cafe (counter orders). Set at sign-up,
-- changed by the manager in the cabinet; GET /sync/settings and /sync/access hand it to the HUB.
-- Portable SQL: runs unchanged on SQLite and PostgreSQL; the code accepts only 'billiards' and 'cafe'.

ALTER TABLE clubs ADD COLUMN business_type TEXT NOT NULL DEFAULT 'billiards';
