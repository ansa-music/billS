-- TS on Supabase: «Смотреть с телефона» for the coffee shop's browser trial (packages/domain/src/trial-watch.ts,
-- apps/cloud/src/trial-watch.ts). The director asks the cash desk for a watch link; the phone then reads the
-- trial's latest snapshot (trials.snapshot) read-only with that link's viewer token. Only the sha256 of a
-- viewer token is stored; a token belongs to one trial; «Отключить телефоны» deletes all of a trial's rows.
-- last_viewed_at is the phone's last check: while it is within 10 minutes, /trial/report answers
-- `watching: true` and the cash desk sends fresher snapshots. Service connection of the functions only:
-- RLS on, no policies, no grants. Rate limits reuse trial_attempts.

CREATE TABLE IF NOT EXISTS public.trial_viewers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_id uuid NOT NULL REFERENCES public.trials (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ix_trial_viewers_trial ON public.trial_viewers (trial_id, last_viewed_at DESC);

ALTER TABLE public.trial_viewers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trial_viewers FROM PUBLIC, anon, authenticated;
