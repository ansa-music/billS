-- Push without Firebase (Supabase only): owner_devices accepts two more platforms.
--   'webpush' — Web Push (VAPID) to the cabinet PWA; token = JSON of the browser's PushSubscription;
--   'ntfy'    — ntfy topic for the Android app; token = topic URL https://ntfy.sh/ts-<random>.
-- The self-hosted cloud (apps/cloud, SQLite) keeps 'android','ios','web' (FCM).
--
-- The CHECK from the base schema is unnamed (inline column check), so every CHECK on
-- owner_devices that mentions platform is dropped, whatever its generated name is.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'public.owner_devices'::regclass
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%platform%'
  LOOP
    EXECUTE format('ALTER TABLE public.owner_devices DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

ALTER TABLE public.owner_devices
  ADD CONSTRAINT owner_devices_platform_check
  CHECK (platform IN ('android', 'ios', 'web', 'webpush', 'ntfy'));
