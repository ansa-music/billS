-- Keep-alive for the free plan: a project with no database activity for 7 days is paused.
-- .github/workflows/keepalive.yml calls this every 3 days with the public anon key.
-- It reads a table and returns nothing about its contents.
CREATE OR REPLACE FUNCTION public.ts_ping() RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM companies) OR true $$;

REVOKE ALL ON FUNCTION public.ts_ping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ts_ping() TO anon, authenticated;
