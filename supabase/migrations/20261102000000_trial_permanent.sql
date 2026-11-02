-- TS on Supabase: «Постоянная версия» of the coffee shop's browser trial (packages/domain/src/trial.ts,
-- apps/cloud/src/trial.ts). Existing rows keep working: every new column has a default or is nullable.
--
--   plan               'trial' (the two-week trial) or 'paid' (permanent: paid until paid_until, or
--                      without an end when paid_until is NULL). ends_at stays the effective end for both
--                      (paid without an end: 2100-01-01), so the status rule does not change.
--   snapshot_encoding  how the last backup copy is stored: 'raw' SQLite or 'gzip' (compressed by the browser).
--   summary            «Смотреть с телефона»: the latest owner's summary the cash register sent, and when.
--   view_token_hash    sha256 of the phone page's own token (read-only, separate from the write token);
--                      NULL = the phone link is off.
--   transfer_code_hash «Перенести на другое устройство»: sha256 of the short code, valid until transfer_expires_at.
--
-- trial_moved_tokens: tokens retired by a transfer, so the old device hears «открыта на другом устройстве»
-- instead of a bare 401. Like the other trial tables: RLS on, no policies, no grants.

ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'trial';
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS paid_until timestamptz;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS snapshot_encoding text NOT NULL DEFAULT 'raw';
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS summary jsonb;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS summary_at timestamptz;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS view_token_hash text;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS transfer_code_hash text;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS transfer_expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trials_plan') THEN
    ALTER TABLE public.trials ADD CONSTRAINT trials_plan CHECK (plan IN ('trial', 'paid'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trials_snapshot_encoding') THEN
    ALTER TABLE public.trials ADD CONSTRAINT trials_snapshot_encoding CHECK (snapshot_encoding IN ('raw', 'gzip'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_trials_view_token ON public.trials (view_token_hash) WHERE view_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_trials_transfer_code ON public.trials (transfer_code_hash) WHERE transfer_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.trial_moved_tokens (
  token_hash text PRIMARY KEY,
  trial_id uuid NOT NULL REFERENCES public.trials (id) ON DELETE CASCADE,
  moved_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.trial_moved_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trial_moved_tokens FROM PUBLIC, anon, authenticated;
