-- TS on Supabase: «Облачная касса» for the coffee shop's browser trial (packages/domain/src/cloud-cafe.ts,
-- apps/cloud/src/cloud-cafe.ts). The platform cabinet moves a trial's café into the cloud cash desk (a Cloudflare
-- Worker, one Durable Object per café: «Перевести в облако» imports the trial's fresh copy) or approves a request
-- straight into it («Подтвердить в облаке»: a new empty café). The trial row keeps the link; the browser cash desk's
-- token is retired, so it stops taking orders and is told where the café went. Rows that exist stay as they are:
-- every new column is NULL until a café goes to the cloud. Service connection of the functions only (RLS is already
-- on for trials, no policies, no grants).

-- with_menu: «Заполнить меню примером» from the welcome form (a request approved into the cloud gets the sample menu
-- when it asked for it; NULL for requests from before this column — treated as yes, the form's default).
-- cloud_code: the café code the Worker gave (12 Crockford characters); the café opens at
-- {CLOUD_HUB_URL}/#/cafe/<code>. One trial — at most one cloud café, never two (the unique index and the claim below).
-- cloud_origin: 'move' (the browser cash desk's data moved in) or 'new' (a request approved into the cloud).
-- cloud_key: the director's key of a café made by «Подтвердить в облаке», kept only until the waiting page says it
-- saved it (POST /trial/cloud/seen) and at most 7 days; the platform owner sees it once in the cabinet.
-- cloud_busy_at: a move or a creation is talking to the Worker right now (a second click waits; 5 minutes at most).
-- cloud_wanted_at: «Перевести в облако» asked the on-line cash desk for a fresh copy at this time (the same
-- snapshot_wanted_at signal as moving the cash desk to another computer); the move waits for a copy newer than it.
-- cloud_terms_error / cloud_terms_at: the last «PUT terms» to the cloud café failed (the Worker's words) / when the
-- café last took the terms. The cabinet shows a warning and «Повторить» while cloud_terms_error is set.
ALTER TABLE public.trials
  ADD COLUMN IF NOT EXISTS with_menu boolean,
  ADD COLUMN IF NOT EXISTS cloud_code text,
  ADD COLUMN IF NOT EXISTS cloud_at timestamptz,
  ADD COLUMN IF NOT EXISTS cloud_origin text,
  ADD COLUMN IF NOT EXISTS cloud_key text,
  ADD COLUMN IF NOT EXISTS cloud_busy_at timestamptz,
  ADD COLUMN IF NOT EXISTS cloud_wanted_at timestamptz,
  ADD COLUMN IF NOT EXISTS cloud_terms_error text,
  ADD COLUMN IF NOT EXISTS cloud_terms_at timestamptz;

ALTER TABLE public.trials DROP CONSTRAINT IF EXISTS trials_cloud_origin;
ALTER TABLE public.trials
  ADD CONSTRAINT trials_cloud_origin CHECK (cloud_origin IS NULL OR cloud_origin IN ('move', 'new'));

CREATE UNIQUE INDEX IF NOT EXISTS ux_trials_cloud_code ON public.trials (cloud_code) WHERE cloud_code IS NOT NULL;

-- ===== The café's codes for the platform owner (packages/domain/src/trial-codes.ts, apps/cloud/src/trial-codes.ts) =====
-- So TS can help a client sign in and fix things, the platform owner sees (behind «Показать», owner only) the café code
-- and the director's sign-in code. Kept in clear on purpose, in this service-only table (RLS on, no grants); never in
-- URLs or logs. cafe_code: the browser trial's «Код кофейни» (stored when the cloud issues it, or when the cash desk
-- reports one that matches code_hash). director_key: the director's code as the cash desk last reported it (or the
-- Worker issued it); director_key_stale: the cash desk said the code it knew stopped working (changed in the cash desk)
-- and it does not know the new one. director_key_next: a new code «Выдать новый код директора» sent to a browser cash
-- desk with its next report's answer, until it reports it installed (director_key_refused: it could not — issue another).
ALTER TABLE public.trials
  ADD COLUMN IF NOT EXISTS cafe_code text,
  ADD COLUMN IF NOT EXISTS director_key text,
  ADD COLUMN IF NOT EXISTS director_key_at timestamptz,
  ADD COLUMN IF NOT EXISTS director_key_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS director_key_next text,
  ADD COLUMN IF NOT EXISTS director_key_next_at timestamptz,
  ADD COLUMN IF NOT EXISTS director_key_refused boolean NOT NULL DEFAULT false;

-- ===== «Купили» (packages/domain/src/trial-paid.ts, apps/cloud/src/trial-paid.ts) =====
-- A café that paid TS for a term: status 'paid' runs until the end of paid_until (YYYY-MM-DD in the café's zone; ends_at
-- holds that last millisecond, so the café's license and «expired» work as for a trial). The amount (minor units) and
-- the note are internal: only the platform cabinet sees them, never the café. paid_at: when it first bought;
-- paid_reminded_at: the platform owner was told this term ends soon (reset by every new payment).
ALTER TABLE public.trials DROP CONSTRAINT IF EXISTS trials_status;
ALTER TABLE public.trials
  ADD CONSTRAINT trials_status CHECK (status IN ('pending', 'active', 'ended', 'rejected', 'permanent', 'paid'));
ALTER TABLE public.trials
  ADD COLUMN IF NOT EXISTS paid_until text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_amount bigint,
  ADD COLUMN IF NOT EXISTS paid_note text,
  ADD COLUMN IF NOT EXISTS paid_reminded_at timestamptz;
ALTER TABLE public.trials DROP CONSTRAINT IF EXISTS trials_paid_until;
ALTER TABLE public.trials
  ADD CONSTRAINT trials_paid_until CHECK (paid_until IS NULL OR paid_until ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');

-- Every «Купили» / «Продлить оплату»: when, until when, the agreed sum and note, who of the platform team entered it.
CREATE TABLE IF NOT EXISTS public.trial_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_id uuid NOT NULL REFERENCES public.trials (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  paid_until text NOT NULL CHECK (paid_until ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  amount bigint,
  note text,
  by_id text,
  by_name text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_trial_payments_trial ON public.trial_payments (trial_id, at DESC);
ALTER TABLE public.trial_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trial_payments FROM PUBLIC, anon, authenticated;
