-- TS on Supabase: «У меня уже есть TS — войти» for the coffee shop's browser trial (packages/domain/src/trial-move.ts,
-- apps/cloud/src/trial-move.ts). The café lives in one browser — the cash desk. To move it to another computer the
-- director types «Код кофейни» there; the cloud hands that computer the latest snapshot and a NEW trial token, and
-- retires the old one, so there is only ever one cash desk. Service connection of the functions only (RLS on, no
-- policies, no grants), except the cash desk's cheap signal function at the end.

-- code_hash: sha256('ts-cafe-code:' || code) of the café code (12 Crockford characters, 60 random bits); the code
-- itself is never stored. desk_gen counts the moves: a move ticket remembers it, so of two moves started at once
-- only the first to finish wins. snapshot_wanted_at: a move asked the on-line cash desk for a fresh copy.
ALTER TABLE public.trials
  ADD COLUMN IF NOT EXISTS code_hash text,
  ADD COLUMN IF NOT EXISTS code_at timestamptz,
  ADD COLUMN IF NOT EXISTS desk_gen int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS moved_at timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_wanted_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS ux_trials_code_hash ON public.trials (code_hash) WHERE code_hash IS NOT NULL;

-- A move in progress: the ticket the new computer got for a right code (only its sha256 is kept).
CREATE TABLE IF NOT EXISTS public.trial_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_id uuid NOT NULL REFERENCES public.trials (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  desk_gen int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz,
  finished_at timestamptz,
  created_ip text
);
CREATE INDEX IF NOT EXISTS ix_trial_moves_trial ON public.trial_moves (trial_id, created_at DESC);

-- Tokens of cash desks that were moved away: such a desk is told «Касса перенесена» (410), never «wrong key».
CREATE TABLE IF NOT EXISTS public.trial_retired_tokens (
  token_hash text PRIMARY KEY,
  trial_id uuid NOT NULL REFERENCES public.trials (id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_trial_retired_tokens_trial ON public.trial_retired_tokens (trial_id);

ALTER TABLE public.trial_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_retired_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trial_moves, public.trial_retired_tokens FROM PUBLIC, anon, authenticated;

-- The cash desk asks every 30 s «is a move waiting for my fresh copy? was I moved away?» through PostgREST
-- (POST /rest/v1/rpc/trial_desk_signal with the public anon key) — not through an Edge Function, whose free
-- invocations are counted. It needs the trial's id and its own token (256 random bits, compared as sha256) and
-- answers one word: 'snapshot' (send a fresh copy now), 'ok', 'moved' (this token was retired by a move) or
-- 'unknown'. A sign of life: last_seen_at is refreshed (at most every 20 s), so a move knows the desk is on line.
CREATE OR REPLACE FUNCTION public.trial_desk_signal(p_id text, p_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_hash text;
  v_stored text;
  v_wanted timestamptz;
BEGIN
  IF p_id IS NULL OR p_token IS NULL OR length(p_token) < 20 OR length(p_token) > 200
     OR p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN 'unknown';
  END IF;
  v_id := p_id::uuid;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT token_hash, snapshot_wanted_at INTO v_stored, v_wanted FROM trials WHERE id = v_id;
  IF FOUND AND v_stored = v_hash THEN
    UPDATE trials SET last_seen_at = now()
      WHERE id = v_id AND (last_seen_at IS NULL OR last_seen_at < now() - interval '20 seconds');
    IF v_wanted IS NOT NULL AND v_wanted > now() - interval '15 minutes' THEN
      RETURN 'snapshot';
    END IF;
    RETURN 'ok';
  END IF;
  IF EXISTS (SELECT 1 FROM trial_retired_tokens WHERE token_hash = v_hash AND trial_id = v_id) THEN
    RETURN 'moved';
  END IF;
  RETURN 'unknown';
END;
$$;
REVOKE ALL ON FUNCTION public.trial_desk_signal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trial_desk_signal(text, text) TO anon, authenticated;
