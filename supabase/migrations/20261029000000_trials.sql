-- TS on Supabase: the coffee shop's browser trial seen by the platform (packages/domain/src/trial.ts,
-- apps/cloud/src/trial.ts). Supabase only: the self-hosted cloud (apps/cloud, SQLite) has no trials.
-- The trial (apps/web, VITE_TRIAL=1) keeps its data in the person's browser; it registers itself through
-- the public Edge Function `trial` (verify_jwt = false) and reports counters and an optional SQLite
-- snapshot with its own token (stored only as sha256). The platform owner reads, extends and ends trials
-- through `platform`. Both tables are for the service connection of the functions only:
-- RLS on, no policies, no grants — nobody reads them through PostgREST.

-- status: 'active' or 'ended' (ended early by the platform); 'expired' is computed (active, ends_at passed).
CREATE TABLE IF NOT EXISTS public.trials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  manager_name text NOT NULL DEFAULT '',
  timezone text,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  stats jsonb,
  snapshot bytea,
  snapshot_at timestamptz,
  snapshot_bytes int,
  created_ip text,
  CONSTRAINT trials_status CHECK (status IN ('active', 'ended'))
);
CREATE INDEX IF NOT EXISTS ix_trials_started ON public.trials (started_at DESC);

-- Rate limit of the public function (the pattern of booking_attempts): one row per attempt, keyed by
-- sha256 of 'start:ip:<address>' or 'report:<trial id>'; rows older than an hour are deleted.
CREATE TABLE IF NOT EXISTS public.trial_attempts (
  id text PRIMARY KEY,
  key_hash text NOT NULL,
  at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trial_attempts_key_at ON public.trial_attempts (key_hash, at);

ALTER TABLE public.trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trials, public.trial_attempts FROM PUBLIC, anon, authenticated;
