-- TS on Supabase: a coffee shop's browser trial starts as a request the platform owner approves
-- (packages/domain/src/trial.ts, apps/cloud/src/trial.ts), and the platform owner is told about every
-- new request in Telegram and by Web Push to the platform cabinet (apps/cloud/src/platform-notify.ts).
-- Rows that exist stay exactly as they are: only the allowed statuses grow and new columns are NULL.

-- status: 'pending' (a request), 'active', 'ended', 'rejected' (a request TS turned down) or
-- 'permanent' (no end date); 'expired' is still computed (active, ends_at passed). A pending row's
-- started_at / ends_at are placeholders until the approval sets them (14 days from then).
ALTER TABLE public.trials DROP CONSTRAINT IF EXISTS trials_status;
ALTER TABLE public.trials
  ADD CONSTRAINT trials_status CHECK (status IN ('pending', 'active', 'ended', 'rejected', 'permanent'));

-- install_hash: sha256 of the browser's random installId (sent with POST /trial/start): a second start
-- with the same id returns that row instead of making another. NULL for trials from before requests.
-- requested_at: when the request came (NULL: a trial from before requests, started at once).
-- decided_at: when TS approved, rejected or made it permanent. owner_message: TS's words on a rejection.
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS install_hash text;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS requested_at timestamptz;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE public.trials ADD COLUMN IF NOT EXISTS owner_message text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_trials_install ON public.trials (install_hash) WHERE install_hash IS NOT NULL;

-- «Уведомления о заявках» of the platform cabinet. The owners' Telegram and devices (owner_telegram,
-- owner_devices) belong to a client company; these belong to a person of the platform team.
-- A Telegram chat linked to a platform person: new trial requests go there. muted = 1 pauses it (/mute).
CREATE TABLE IF NOT EXISTS public.platform_telegram (
  chat_id text PRIMARY KEY,
  staff_id text NOT NULL REFERENCES public.platform_staff (id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  muted integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_platform_telegram_staff ON public.platform_telegram (staff_id);

-- One-time link codes from the platform cabinet: only sha256 is stored, 15 minutes, used once.
CREATE TABLE IF NOT EXISTS public.platform_telegram_codes (
  code_hash text PRIMARY KEY,
  staff_id text NOT NULL REFERENCES public.platform_staff (id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  used_at bigint
);
CREATE INDEX IF NOT EXISTS ix_platform_telegram_codes_staff ON public.platform_telegram_codes (staff_id);

-- Web Push subscriptions of the platform cabinet (the browser's PushSubscription JSON as the token).
CREATE TABLE IF NOT EXISTS public.platform_devices (
  id text PRIMARY KEY,
  staff_id text NOT NULL REFERENCES public.platform_staff (id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('webpush')),
  token text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  last_error text
);
CREATE INDEX IF NOT EXISTS ix_platform_devices_staff ON public.platform_devices (staff_id);

-- Service connection of the functions only: RLS on, no policies, no grants.
ALTER TABLE public.platform_telegram ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_telegram_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_telegram, public.platform_telegram_codes, public.platform_devices FROM PUBLIC, anon, authenticated;
