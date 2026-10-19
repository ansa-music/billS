-- Every 5 minutes pg_cron calls the Edge Function `notify` through pg_net:
-- watchdogs (HUB silent, cash shift left open) + retry of PENDING pushes.
-- Supabase only (pg_cron, pg_net, Vault); the PGlite test harness skips *_cron.sql.
--
-- ===========================================================================
-- ONE-TIME SETUP (run by hand in Dashboard → SQL Editor, values are NOT in git):
--
--   -- 1. A random secret, at least 16 characters (e.g. `openssl rand -hex 24`):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'ts_project_url');
--   select vault.create_secret('<the same secret as NOTIFY_SECRET>', 'ts_notify_secret');
--
--   -- 2. The same secret for the function (terminal):
--   --    supabase secrets set NOTIFY_SECRET=<the same secret>
--
--   -- Change a value later:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'ts_notify_secret'), '<new secret>');
--
--   -- Check that it runs (a row per call, status_code 200 expected):
--   select jobname, schedule, active from cron.job where jobname = 'ts-notify';
--   select status_code, content, created from net._http_response order by created desc limit 5;
--
-- Without the Vault secrets the job runs but the call fails (url is NULL) — nothing breaks.
-- Fallback without pg_cron: a GitHub Actions schedule that POSTs to /functions/v1/notify
-- with the header x-ts-cron (see docs).
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Re-running the migration replaces the job instead of adding a second one.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ts-notify';

SELECT cron.schedule(
  'ts-notify',
  '*/5 * * * *',
  $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'ts_project_url') || '/functions/v1/notify',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-ts-cron', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'ts_notify_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);
