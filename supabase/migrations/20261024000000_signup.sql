-- TS on Supabase: self sign-up in the cabinet (Edge Function `signup`) — the portable SQL of
-- apps/cloud/src/migrations/005_business_type.sql verbatim (supabase/tests/schema.test.ts keeps
-- them identical), then the Supabase part: the per-IP limit of sign-ups, closed to the API roles.

-- ===== apps/cloud/src/migrations/005_business_type.sql =====
-- What a branch is: billiards (tables, time, lamps) or cafe (counter orders). Set at sign-up,
-- changed by the manager in the cabinet; GET /sync/settings and /sync/access hand it to the HUB.
-- Portable SQL: runs unchanged on SQLite and PostgreSQL; the code accepts only 'billiards' and 'cafe'.

ALTER TABLE clubs ADD COLUMN business_type TEXT NOT NULL DEFAULT 'billiards';

-- ===== Supabase: sign-up attempts (only the service connection of the functions) =====

-- One row per sign-up attempt; the address is stored as sha256, rows older than a day are deleted.
CREATE TABLE IF NOT EXISTS public.signup_attempts (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_signup_attempts_ip_at ON public.signup_attempts (ip_hash, at);

ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.signup_attempts FROM PUBLIC, anon, authenticated;
