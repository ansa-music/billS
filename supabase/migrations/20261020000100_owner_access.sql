-- TS on Supabase: owner sign-in through Supabase Auth, row level security,
-- the owner report RPCs and Realtime for alerts.
--
-- The report functions return jsonb shaped exactly like the JSON apps/cloud
-- serves over HTTP (apps/cloud/src/reports.ts, auth.ts, push.ts); the tests in
-- supabase/tests/reports.test.ts compare both outputs on the same data.
-- Every PostgREST-callable function is SECURITY DEFINER with search_path '' and
-- a company check, EXECUTE for `authenticated` only. Helpers live in the schema
-- ts_internal, which PostgREST does not expose and API roles cannot use.

CREATE SCHEMA IF NOT EXISTS ts_internal;
REVOKE ALL ON SCHEMA ts_internal FROM PUBLIC;

-- ===========================================================================
-- 1. Owner <-> Supabase Auth user
-- ===========================================================================

ALTER TABLE public.owners
  ADD COLUMN auth_user_id uuid UNIQUE NULL REFERENCES auth.users (id) ON DELETE SET NULL;

/**
 * True when the auth user's email may be trusted: confirmed, or the auth
 * schema has no confirmation column at all (test stubs).
 */
CREATE FUNCTION ts_internal.auth_email_trusted(u jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT NOT (u ? 'email_confirmed_at') OR (u ->> 'email_confirmed_at') IS NOT NULL
$$;

/** Links the oldest unlinked owner with the same lower(email) to a (confirmed) auth user. */
CREATE FUNCTION ts_internal.link_owner_to_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.email IS NULL OR NOT ts_internal.auth_email_trusted(to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.owners o WHERE o.auth_user_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  UPDATE public.owners SET auth_user_id = NEW.id
  WHERE id = (
    SELECT o.id FROM public.owners o
    WHERE lower(o.email) = lower(NEW.email) AND o.auth_user_id IS NULL
    ORDER BY o.created_at, o.id
    LIMIT 1
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER ts_link_owner
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION ts_internal.link_owner_to_auth_user();

/** An owner created by the platform after its auth user exists is linked at once. */
CREATE FUNCTION ts_internal.link_new_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid;
BEGIN
  IF NEW.auth_user_id IS NULL THEN
    SELECT u.id INTO v_uid FROM auth.users u
    WHERE lower(u.email) = lower(NEW.email)
      AND ts_internal.auth_email_trusted(to_jsonb(u))
      AND NOT EXISTS (SELECT 1 FROM public.owners o WHERE o.auth_user_id = u.id)
    LIMIT 1;
    NEW.auth_user_id := v_uid;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ts_link_new_owner
  BEFORE INSERT ON public.owners
  FOR EACH ROW EXECUTE FUNCTION ts_internal.link_new_owner();

-- Owners and auth users that already exist.
UPDATE public.owners o SET auth_user_id = u.id
FROM auth.users u
WHERE lower(u.email) = lower(o.email) AND o.auth_user_id IS NULL
  AND ts_internal.auth_email_trusted(to_jsonb(u))
  AND NOT EXISTS (SELECT 1 FROM public.owners x WHERE x.auth_user_id = u.id);

/** owners.id of the signed-in user, or NULL. */
CREATE FUNCTION public.current_owner_id() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id FROM public.owners o WHERE o.auth_user_id = auth.uid()
$$;

/** Company of the signed-in owner, or NULL. */
CREATE FUNCTION public.my_company_id() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.company_id FROM public.owners o WHERE o.auth_user_id = auth.uid()
$$;

-- ===========================================================================
-- 2. Privileges and row level security
-- ===========================================================================

-- Runtime flags written by Edge Functions (e.g. push_configured = '1' once VAPID keys are set).
-- Service role only: RLS on, no policies, no grants for anon/authenticated.
CREATE TABLE public.ts_runtime (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at bigint NOT NULL
);

-- Start from nothing for the API roles on every table that exists now.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END
$$;

-- Tables created later by the migration role do not go to anon by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- Reads of the company's own rows.
GRANT SELECT ON public.companies, public.clubs, public.club_settings, public.sessions, public.checks,
  public.payments, public.shifts, public.cash_movements, public.power_outages, public.alerts,
  public.daily_stats
  TO authenticated;
-- hubs without api_key_hash, owners without password_hash, owner_keys without key_hash.
GRANT SELECT (id, club_id, name, created_at, last_seen_at, last_outbox_id, settings_version, offline_alerted_at)
  ON public.hubs TO authenticated;
GRANT SELECT (id, company_id, email, name, created_at, auth_user_id) ON public.owners TO authenticated;
GRANT SELECT (id, owner_id, prefix, label, created_at, last_used_at, revoked_at) ON public.owner_keys TO authenticated;
-- The owner's own phones and notification rules.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.owner_devices, public.push_rules TO authenticated;
-- events, owner_sessions, push_queue: nothing for anon/authenticated.

CREATE POLICY own_company ON public.companies FOR SELECT TO authenticated
  USING (id = (SELECT public.my_company_id()));
CREATE POLICY own_company ON public.clubs FOR SELECT TO authenticated
  USING (company_id = (SELECT public.my_company_id()));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hubs', 'club_settings', 'sessions', 'checks', 'payments', 'shifts', 'cash_movements',
                           'power_outages', 'alerts', 'daily_stats'] LOOP
    EXECUTE format(
      'CREATE POLICY own_company ON public.%I FOR SELECT TO authenticated
         USING (club_id IN (SELECT c.id FROM public.clubs c WHERE c.company_id = (SELECT public.my_company_id())))',
      t);
  END LOOP;
END
$$;

CREATE POLICY own_row ON public.owners FOR SELECT TO authenticated
  USING (id = (SELECT public.current_owner_id()));
CREATE POLICY own_rows ON public.owner_keys FOR SELECT TO authenticated
  USING (owner_id = (SELECT public.current_owner_id()));
CREATE POLICY own_rows ON public.owner_devices FOR ALL TO authenticated
  USING (owner_id = (SELECT public.current_owner_id()))
  WITH CHECK (owner_id = (SELECT public.current_owner_id()));
CREATE POLICY own_rows ON public.push_rules FOR ALL TO authenticated
  USING (owner_id = (SELECT public.current_owner_id()))
  WITH CHECK (
    owner_id = (SELECT public.current_owner_id())
    AND (club_id = '' OR club_id IN (SELECT c.id FROM public.clubs c WHERE c.company_id = (SELECT public.my_company_id())))
  );

-- ===========================================================================
-- 3. Report helpers (mirror apps/cloud/src/localtime.ts, settings.ts, reports.ts)
-- ===========================================================================

CREATE FUNCTION ts_internal.now_ms() RETURNS bigint
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT floor(extract(epoch FROM now()) * 1000)::bigint
$$;

/** Wall-clock time of an instant in a time zone. */
CREATE FUNCTION ts_internal.local_ts(p_ms bigint, p_tz text) RETURNS timestamp
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT ('1970-01-01 00:00:00+00'::timestamptz + p_ms * interval '1 millisecond') AT TIME ZONE p_tz
$$;

/** localDay(): 'YYYY-MM-DD' of an instant in the zone. */
CREATE FUNCTION ts_internal.local_day(p_ms bigint, p_tz text) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT to_char(ts_internal.local_ts(p_ms, p_tz), 'YYYY-MM-DD')
$$;

/** dayStart(): the instant local midnight of `p_day` happens. */
CREATE FUNCTION ts_internal.day_start(p_day text, p_tz text) RETURNS bigint
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT floor(extract(epoch FROM (p_day::date::timestamp AT TIME ZONE p_tz)) * 1000)::bigint
$$;

CREATE FUNCTION ts_internal.add_days(p_day text, p_n integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT to_char(p_day::date + p_n, 'YYYY-MM-DD')
$$;

CREATE FUNCTION ts_internal.month_start(p_day text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT left(p_day, 7) || '-01'
$$;

/** isValidDay(). */
CREATE FUNCTION ts_internal.is_valid_day(p_day text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  d date;
BEGIN
  IF p_day IS NULL OR p_day !~ '^\d{4}-\d{2}-\d{2}$' OR left(p_day, 4)::int < 100 THEN
    RETURN false;
  END IF;
  d := p_day::date;
  RETURN to_char(d, 'YYYY-MM-DD') = p_day;
EXCEPTION WHEN others THEN
  RETURN false;
END
$$;

/** sliceByHour(): [from, to) cut into pieces that each lie in one local hour. */
CREATE FUNCTION ts_internal.slice_by_hour(p_from bigint, p_to bigint, p_tz text)
RETURNS TABLE (hour integer, ms bigint)
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  t bigint := p_from;
  nxt bigint;
  l timestamp;
BEGIN
  WHILE t < p_to LOOP
    l := ts_internal.local_ts(t, p_tz);
    nxt := least(
      t + greatest((60 - extract(minute FROM l)::bigint) * 60000 - floor(extract(second FROM l) * 1000)::bigint, 1),
      p_to);
    hour := extract(hour FROM l)::integer;
    ms := nxt - t;
    RETURN NEXT;
    t := nxt;
  END LOOP;
END
$$;

/** JSON.parse with a fallback (loadSettings' parseJson). */
CREATE FUNCTION ts_internal.try_jsonb(p_text text, p_fallback jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_text IS NULL THEN
    RETURN p_fallback;
  END IF;
  RETURN p_text::jsonb;
EXCEPTION WHEN others THEN
  RETURN p_fallback;
END
$$;

/** Current settings of a club as a ClubSnapshot (toClubSettings(loadSettings())). */
CREATE FUNCTION ts_internal.club_snapshot(c public.clubs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH d AS (SELECT jsonb_build_object('name', c.name, 'timezone', c.timezone, 'currency', c.currency) AS club)
  SELECT coalesce(
    (SELECT jsonb_build_object(
              'version', s.version,
              'club', ts_internal.try_jsonb(s.club_json, d.club),
              'tariffs', ts_internal.try_jsonb(s.tariffs_json, '[]'::jsonb),
              'tables', ts_internal.try_jsonb(s.tables_json, '[]'::jsonb),
              'staff', ts_internal.try_jsonb(s.staff_json, '[]'::jsonb))
     FROM public.club_settings s WHERE s.club_id = c.id),
    jsonb_build_object('version', 0, 'club', d.club, 'tariffs', '[]'::jsonb, 'tables', '[]'::jsonb, 'staff', '[]'::jsonb))
  FROM d
$$;

/** The tables list of a snapshot as rows with their position. */
CREATE FUNCTION ts_internal.snapshot_tables(p_tables jsonb) RETURNS TABLE (t jsonb, pos bigint)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT e.t, e.pos FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_tables) = 'array' THEN p_tables ELSE '[]'::jsonb END)
    WITH ORDINALITY AS e(t, pos)
$$;

/** tableNames(settings).get(id) ?? null: the last table with that id wins, like a Map. */
CREATE FUNCTION ts_internal.table_name(p_tables jsonb, p_id text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT x.t ->> 'name' FROM ts_internal.snapshot_tables(p_tables) x
  WHERE x.t ->> 'id' = p_id ORDER BY x.pos DESC LIMIT 1
$$;

/** PeriodStats from the sums of daily_stats columns. */
CREATE FUNCTION ts_internal.period_json(
  p_billed numeric, p_games numeric, p_played numeric, p_paid_total numeric, p_cash numeric, p_card numeric,
  p_qr numeric, p_refunded numeric, p_checks numeric, p_discounts numeric, p_cancelled numeric
) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  WITH v AS (
    SELECT coalesce(p_paid_total, 0)::bigint - coalesce(p_refunded, 0)::bigint AS revenue,
           coalesce(p_checks, 0)::bigint AS checks
  )
  SELECT jsonb_build_object(
    'revenue', v.revenue,
    'billed', coalesce(p_billed, 0)::bigint,
    'games', coalesce(p_games, 0)::bigint,
    'playedSeconds', coalesce(p_played, 0)::bigint,
    'paid', jsonb_build_object('cash', coalesce(p_cash, 0)::bigint, 'card', coalesce(p_card, 0)::bigint,
                               'qr', coalesce(p_qr, 0)::bigint, 'total', coalesce(p_paid_total, 0)::bigint),
    'refunded', coalesce(p_refunded, 0)::bigint,
    'checksPaid', v.checks,
    'discounts', coalesce(p_discounts, 0)::bigint,
    -- Math.round: halves go up, also for negative numbers.
    'averageCheck', CASE WHEN v.checks > 0 THEN floor(v.revenue::numeric / v.checks + 0.5)::bigint ELSE 0 END,
    'cancelledGames', coalesce(p_cancelled, 0)::bigint)
  FROM v
$$;

CREATE FUNCTION ts_internal.period_stats(p_club text, p_from text, p_to text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT ts_internal.period_json(sum(revenue), sum(games), sum(played_seconds), sum(paid_total), sum(paid_cash),
                                 sum(paid_card), sum(paid_qr), sum(refunded), sum(checks_paid), sum(discounts),
                                 sum(cancelled_games))
  FROM public.daily_stats WHERE club_id = p_club AND day >= p_from AND day <= p_to
$$;

/** sumStats(): the clubs' PeriodStats under `p_key` added up. */
CREATE FUNCTION ts_internal.sum_stats(p_clubs jsonb, p_key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ts_internal.period_json(
    sum((e -> p_key ->> 'billed')::numeric), sum((e -> p_key ->> 'games')::numeric),
    sum((e -> p_key ->> 'playedSeconds')::numeric), sum((e -> p_key -> 'paid' ->> 'total')::numeric),
    sum((e -> p_key -> 'paid' ->> 'cash')::numeric), sum((e -> p_key -> 'paid' ->> 'card')::numeric),
    sum((e -> p_key -> 'paid' ->> 'qr')::numeric), sum((e -> p_key ->> 'refunded')::numeric),
    sum((e -> p_key ->> 'checksPaid')::numeric), sum((e -> p_key ->> 'discounts')::numeric),
    sum((e -> p_key ->> 'cancelledGames')::numeric))
  FROM jsonb_array_elements(p_clubs) e
$$;

/** CloudShiftView. */
CREATE FUNCTION ts_internal.shift_view(s public.shifts, p_club_name text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH p AS (
    SELECT
      coalesce(sum(amount) FILTER (WHERE kind <> 'REFUND' AND method = 'CASH'), 0)::bigint AS s_cash,
      coalesce(sum(amount) FILTER (WHERE kind <> 'REFUND' AND method = 'CARD'), 0)::bigint AS s_card,
      coalesce(sum(amount) FILTER (WHERE kind <> 'REFUND' AND method = 'QR'), 0)::bigint AS s_qr,
      coalesce(sum(amount) FILTER (WHERE kind <> 'REFUND'), 0)::bigint AS s_total,
      coalesce(sum(amount) FILTER (WHERE kind = 'REFUND' AND method = 'CASH'), 0)::bigint AS r_cash,
      coalesce(sum(amount) FILTER (WHERE kind = 'REFUND' AND method = 'CARD'), 0)::bigint AS r_card,
      coalesce(sum(amount) FILTER (WHERE kind = 'REFUND' AND method = 'QR'), 0)::bigint AS r_qr,
      coalesce(sum(amount) FILTER (WHERE kind = 'REFUND'), 0)::bigint AS r_total,
      count(*) FILTER (WHERE kind = 'REFUND') AS refunds_count,
      count(DISTINCT operation_id) FILTER (WHERE kind = 'PAYMENT') AS payments_count
    FROM public.payments WHERE shift_id = s.id
  ),
  c AS (SELECT count(*) AS checks_paid FROM public.checks WHERE status = 'PAID' AND shift_id = s.id),
  m AS (
    SELECT coalesce(sum(amount) FILTER (WHERE kind = 'DEPOSIT'), 0)::bigint AS deposits,
           coalesce(sum(amount) FILTER (WHERE kind <> 'DEPOSIT'), 0)::bigint AS withdrawals
    FROM public.cash_movements WHERE shift_id = s.id
  )
  SELECT jsonb_build_object(
    'id', s.id,
    'clubId', s.club_id,
    'clubName', p_club_name,
    'number', coalesce(s.number, 0),
    'status', s.status,
    'openedAt', s.opened_at,
    'openedBy', s.opened_by,
    'closedAt', s.closed_at,
    'closedBy', s.closed_by,
    'openingFloat', coalesce(s.opening_float, 0),
    'sales', jsonb_build_object('cash', p.s_cash, 'card', p.s_card, 'qr', p.s_qr, 'total', p.s_total),
    'refunds', jsonb_build_object('cash', p.r_cash, 'card', p.r_card, 'qr', p.r_qr, 'total', p.r_total),
    'net', CASE
      WHEN s.status = 'CLOSED' AND s.net_total IS NOT NULL THEN
        jsonb_build_object('cash', coalesce(s.net_cash, 0), 'card', coalesce(s.net_card, 0),
                           'qr', coalesce(s.net_qr, 0), 'total', s.net_total)
      ELSE
        jsonb_build_object('cash', p.s_cash - p.r_cash, 'card', p.s_card - p.r_card,
                           'qr', p.s_qr - p.r_qr, 'total', p.s_total - p.r_total)
    END,
    'deposits', m.deposits,
    'withdrawals', m.withdrawals,
    'expectedCash', CASE WHEN s.status = 'CLOSED' THEN s.expected_cash END,
    'countedCash', CASE WHEN s.status = 'CLOSED' THEN s.counted_cash END,
    'difference', CASE WHEN s.status = 'CLOSED' THEN s.difference END,
    'note', CASE WHEN s.status = 'CLOSED' THEN s.note END,
    'checksPaid', c.checks_paid,
    'paymentsCount', p.payments_count,
    'refundsCount', p.refunds_count)
  FROM p, c, m
$$;

/** CloudAlertView. */
CREATE FUNCTION ts_internal.alert_view(a public.alerts, p_club_name text, p_tables jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', a.id,
    'clubId', a.club_id,
    'clubName', p_club_name,
    'at', a.at,
    'kind', a.kind,
    'tableId', a.table_id,
    'tableName', CASE WHEN coalesce(a.table_id, '') <> '' THEN ts_internal.table_name(p_tables, a.table_id) END,
    'message', a.message,
    'resolvedAt', a.resolved_at)
$$;

/** CloudSessionView. */
CREATE FUNCTION ts_internal.session_view(s public.sessions, p_check_number integer, p_tables jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', s.id,
    'clubId', s.club_id,
    'tableId', s.table_id,
    'tableName', ts_internal.table_name(p_tables, s.table_id),
    'status', s.status,
    'tariffName', s.tariff_name,
    'openedBy', s.opened_by,
    'stoppedBy', s.stopped_by,
    'requestedAt', s.requested_at,
    'startedAt', s.started_at,
    'stoppedAt', s.stopped_at,
    'billedSeconds', s.billed_seconds,
    'pausedSeconds', s.paused_seconds,
    'amount', s.amount,
    'checkId', s.check_id,
    'checkNumber', p_check_number,
    'paidAt', s.paid_at,
    'cancelReason', coalesce(s.cancel_reason, s.failure_reason),
    'cancelApprovedBy', s.cancel_approved_by,
    'prepaidMinutes', s.prepaid_minutes,
    'pausedAt', CASE WHEN s.status = 'PAUSED' THEN s.pause_started_at END,
    'pauseReason', CASE WHEN s.status = 'PAUSED' THEN s.pause_reason END)
$$;

/** HubStatus of the club's first HUB, or NULL. */
CREATE FUNCTION ts_internal.hub_status(p_club text, p_settings_version numeric, p_now bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', h.id,
    'name', h.name,
    'lastSeenAt', h.last_seen_at,
    'online', h.last_seen_at IS NOT NULL AND p_now - h.last_seen_at < 180000,
    'lastOutboxId', h.last_outbox_id,
    'settingsVersion', h.settings_version,
    'pendingSettings', p_settings_version > h.settings_version)
  FROM public.hubs h WHERE h.club_id = p_club
  ORDER BY h.created_at LIMIT 1
$$;

/** ClubSummary. */
CREATE FUNCTION ts_internal.club_summary(c public.clubs, p_snap jsonb, p_now bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_today text := ts_internal.local_day(p_now, c.timezone);
BEGIN
  RETURN jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'timezone', c.timezone,
    'currency', c.currency,
    'today', ts_internal.period_stats(c.id, v_today, v_today),
    'week', ts_internal.period_stats(c.id, ts_internal.add_days(v_today, -6), v_today),
    'month', ts_internal.period_stats(c.id, ts_internal.month_start(v_today), v_today),
    'openAlerts', (SELECT count(*) FROM public.alerts a WHERE a.club_id = c.id AND a.resolved_at IS NULL),
    'liveGames', (SELECT count(*) FROM public.sessions s WHERE s.club_id = c.id AND s.status IN ('OPENING', 'ACTIVE', 'PAUSED')),
    'tablesCount', (SELECT count(*) FROM ts_internal.snapshot_tables(p_snap -> 'tables') x WHERE x.t -> 'isActive' = 'true'::jsonb),
    'hub', ts_internal.hub_status(c.id, (p_snap ->> 'version')::numeric, p_now),
    'openShift', (SELECT ts_internal.shift_view(s, c.name) FROM public.shifts s
                  WHERE s.club_id = c.id AND s.status = 'OPEN' ORDER BY s.opened_at DESC NULLS LAST LIMIT 1),
    'lastClosedShift', (SELECT ts_internal.shift_view(s, c.name) FROM public.shifts s
                        WHERE s.club_id = c.id AND s.status = 'CLOSED' ORDER BY s.closed_at DESC NULLS LAST LIMIT 1));
END
$$;

/** Busy time of games that overlap [from, to), cut by local hour. Live games run until now. */
CREATE FUNCTION ts_internal.load_slices(p_club text, p_tz text, p_now bigint, p_from bigint, p_to bigint)
RETURNS TABLE (session_id text, table_id text, hour integer, ms bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT s.id, s.table_id, sl.hour, sl.ms
  FROM public.sessions s
  CROSS JOIN LATERAL ts_internal.slice_by_hour(greatest(s.started_at, p_from),
                                               least(coalesce(s.stopped_at, p_now), p_to), p_tz) sl
  WHERE s.club_id = p_club AND s.started_at IS NOT NULL AND s.started_at < p_to
    AND (s.stopped_at IS NULL OR s.stopped_at > p_from)
$$;

/** hourLoad(): HourLoad[24]. */
CREATE FUNCTION ts_internal.hour_load(p_club text, p_tz text, p_now bigint, p_from bigint, p_to bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH x AS (
    SELECT l.hour, sum(l.ms) AS ms, count(DISTINCT l.session_id) AS games
    FROM ts_internal.load_slices(p_club, p_tz, p_now, p_from, p_to) l GROUP BY l.hour
  )
  SELECT jsonb_agg(jsonb_build_object('hour', h, 'busySeconds', coalesce(round(x.ms / 1000.0), 0)::bigint,
                                      'games', coalesce(x.games, 0)) ORDER BY h)
  FROM generate_series(0, 23) h LEFT JOIN x ON x.hour = h
$$;

/** tableStats(): active tables by sortOrder, then tables the HUB no longer reports. */
CREATE FUNCTION ts_internal.table_stats(p_club text, p_tz text, p_tables jsonb, p_now bigint, p_from bigint, p_to bigint)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH loaded AS (
    SELECT s.id, s.table_id, s.status, s.stopped_at, s.amount, s.played_seconds, s.requested_at
    FROM public.sessions s
    WHERE s.club_id = p_club AND s.started_at IS NOT NULL AND s.started_at < p_to
      AND (s.stopped_at IS NULL OR s.stopped_at > p_from)
  ),
  per_table AS (
    SELECT r.table_id,
           min(r.requested_at) AS first_seen,
           coalesce(sum(coalesce(r.amount, 0)) FILTER (WHERE b), 0)::bigint AS revenue,
           count(*) FILTER (WHERE b) AS games,
           coalesce(sum(coalesce(r.played_seconds, 0)) FILTER (WHERE b), 0)::bigint AS played
    FROM (SELECT r.*, (r.stopped_at IS NOT NULL AND r.stopped_at >= p_from AND r.stopped_at < p_to
                       AND r.status IN ('AWAITING_PAYMENT', 'CLOSED')) AS b FROM loaded r) r
    GROUP BY r.table_id
  ),
  slices AS (
    SELECT l.table_id, l.hour, sum(l.ms) AS ms
    FROM ts_internal.load_slices(p_club, p_tz, p_now, p_from, p_to) l GROUP BY l.table_id, l.hour
  ),
  by_hour AS (
    SELECT pt.table_id,
           jsonb_agg(coalesce(round(sl.ms / 1000.0), 0)::bigint ORDER BY h) AS hours
    FROM per_table pt CROSS JOIN generate_series(0, 23) h
    LEFT JOIN slices sl ON sl.table_id = pt.table_id AND sl.hour = h
    GROUP BY pt.table_id
  ),
  active AS (
    SELECT x.t, x.pos FROM ts_internal.snapshot_tables(p_tables) x WHERE x.t -> 'isActive' = 'true'::jsonb
  ),
  known AS (
    SELECT jsonb_build_object(
             'id', a.t -> 'id', 'name', a.t -> 'name', 'kind', a.t -> 'kind',
             'revenue', coalesce(pt.revenue, 0), 'games', coalesce(pt.games, 0),
             'playedSeconds', coalesce(pt.played, 0),
             'byHour', coalesce(bh.hours, (SELECT jsonb_agg(0) FROM generate_series(1, 24))))
             AS v,
           row_number() OVER (ORDER BY (a.t ->> 'sortOrder')::numeric, a.pos) AS ord
    FROM active a
    LEFT JOIN per_table pt ON pt.table_id = a.t ->> 'id'
    LEFT JOIN by_hour bh ON bh.table_id = a.t ->> 'id'
  ),
  unknown AS (
    SELECT jsonb_build_object(
             'id', pt.table_id,
             'name', coalesce((SELECT x.t ->> 'name' FROM ts_internal.snapshot_tables(p_tables) x
                               WHERE x.t ->> 'id' = pt.table_id ORDER BY x.pos LIMIT 1), pt.table_id),
             'kind', 'pool',
             'revenue', pt.revenue, 'games', pt.games, 'playedSeconds', pt.played,
             'byHour', bh.hours) AS v,
           (SELECT count(*) FROM known) + row_number() OVER (ORDER BY pt.first_seen, pt.table_id) AS ord
    FROM per_table pt JOIN by_hour bh ON bh.table_id = pt.table_id
    WHERE NOT EXISTS (SELECT 1 FROM active a WHERE a.t ->> 'id' = pt.table_id)
  )
  SELECT coalesce(jsonb_agg(u.v ORDER BY u.ord), '[]'::jsonb)
  FROM (SELECT v, ord FROM known UNION ALL SELECT v, ord FROM unknown) u
$$;

/** The signed-in owner, or error UNAUTHORIZED. */
CREATE FUNCTION ts_internal.require_owner() RETURNS public.owners
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  me public.owners;
BEGIN
  SELECT * INTO me FROM public.owners o WHERE o.auth_user_id = auth.uid();
  IF me.id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501', HINT = 'Войдите в кабинет';
  END IF;
  RETURN me;
END
$$;

/** A club of the owner's company, or error CLUB_NOT_FOUND. */
CREATE FUNCTION ts_internal.require_club(p_company text, p_club text) RETURNS public.clubs
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  c public.clubs;
BEGIN
  SELECT * INTO c FROM public.clubs x WHERE x.id = p_club AND x.company_id = p_company;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'CLUB_NOT_FOUND' USING ERRCODE = 'P0002', HINT = 'Клуб не найден';
  END IF;
  RETURN c;
END
$$;

-- ---------------------------------------------------------------------------
-- Push settings (apps/cloud/src/push.ts, packages/domain/src/push.ts)
-- ---------------------------------------------------------------------------

/** PUSH_KINDS of packages/domain/src/push.ts, in the cabinet's order. */
CREATE FUNCTION ts_internal.push_kinds() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '[
    {"kind": "LIGHT_WITHOUT_GAME", "label": "Свет горит без игры", "defaultOn": true},
    {"kind": "LAMP_DARK_DURING_GAME", "label": "Игра идёт без света", "defaultOn": true},
    {"kind": "POWER_ON_BATTERY", "label": "Нет электричества, клуб на ИБП", "defaultOn": true},
    {"kind": "POWER_CRITICAL", "label": "Батарея ИБП почти разряжена", "defaultOn": true},
    {"kind": "HUB_OFFLINE", "label": "HUB клуба пропал со связи", "defaultOn": true},
    {"kind": "SHIFT_NOT_CLOSED", "label": "Кассовая смена не закрыта", "defaultOn": true},
    {"kind": "UPS_UNREACHABLE", "label": "ИБП не отвечает", "defaultOn": false},
    {"kind": "LAMP_FAILED", "label": "Лампа не включилась или не выключилась", "defaultOn": false},
    {"kind": "PREPAID_NOT_STARTED", "label": "Оплаченная игра не началась", "defaultOn": false},
    {"kind": "OTHER", "label": "Прочие тревоги", "defaultOn": false}
  ]'::jsonb
$$;

CREATE FUNCTION ts_internal.is_push_kind(p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(ts_internal.push_kinds()) k WHERE k ->> 'kind' = p_kind)
$$;

/** Whether pushes leave the cloud: the Edge sender marks itself configured in ts_runtime. */
CREATE FUNCTION ts_internal.push_enabled() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.ts_runtime r WHERE r.key = 'push_configured' AND r.value = '1')
$$;

/** PushSettingsView of an owner. */
CREATE FUNCTION ts_internal.push_settings(p_owner text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'pushEnabled', ts_internal.push_enabled(),
    'kinds', ts_internal.push_kinds(),
    'rules', coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'clubId', nullif(r.club_id, ''), 'enabled', r.enabled = 1)
                       ORDER BY r.kind COLLATE "C", r.club_id COLLATE "C")
      FROM public.push_rules r WHERE r.owner_id = p_owner AND ts_internal.is_push_kind(r.kind)), '[]'::jsonb),
    'devices', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'platform', d.platform, 'name', d.name, 'createdAt', d.created_at,
                                          'lastSeenAt', d.last_seen_at, 'lastError', d.last_error)
                       ORDER BY d.created_at, d.id)
      FROM public.owner_devices d WHERE d.owner_id = p_owner), '[]'::jsonb))
$$;

-- ===========================================================================
-- 4. RPC for the cabinet (supabase.rpc(name, args))
-- ===========================================================================

/** OwnerView of the signed-in owner. */
CREATE FUNCTION public.owner_me() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me public.owners := ts_internal.require_owner();
BEGIN
  RETURN (
    SELECT jsonb_build_object('id', me.id, 'email', me.email, 'name', me.name,
                              'company', jsonb_build_object('id', co.id, 'name', co.name))
    FROM public.companies co WHERE co.id = me.company_id);
END
$$;

/** OwnerOverview. */
CREATE FUNCTION public.owner_overview(p_now bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me public.owners := ts_internal.require_owner();
  v_now bigint := coalesce(p_now, ts_internal.now_ms());
  v_company jsonb;
  v_clubs jsonb := '[]'::jsonb;
  v_tables jsonb := '{}'::jsonb;
  v_snap jsonb;
  c public.clubs;
BEGIN
  SELECT jsonb_build_object('id', co.id, 'name', co.name) INTO v_company
  FROM public.companies co WHERE co.id = me.company_id;

  FOR c IN SELECT * FROM public.clubs x WHERE x.company_id = me.company_id ORDER BY x.created_at, x.name COLLATE "C" LOOP
    v_snap := ts_internal.club_snapshot(c);
    v_tables := v_tables || jsonb_build_object(c.id, v_snap -> 'tables');
    v_clubs := v_clubs || jsonb_build_array(ts_internal.club_summary(c, v_snap, v_now));
  END LOOP;

  RETURN jsonb_build_object(
    'serverNow', v_now,
    'company', v_company,
    'clubs', v_clubs,
    'totals', jsonb_build_object(
      'today', ts_internal.sum_stats(v_clubs, 'today'),
      'week', ts_internal.sum_stats(v_clubs, 'week'),
      'month', ts_internal.sum_stats(v_clubs, 'month')),
    'alerts', coalesce((
      SELECT jsonb_agg(ts_internal.alert_view(x.a, x.club_name, v_tables -> (x.a).club_id) ORDER BY x.ord)
      FROM (
        SELECT a, cl.name AS club_name, row_number() OVER (ORDER BY a.at DESC, a.id) AS ord
        FROM public.alerts a JOIN public.clubs cl ON cl.id = a.club_id
        WHERE cl.company_id = me.company_id AND a.resolved_at IS NULL
        ORDER BY a.at DESC, a.id LIMIT 100
      ) x), '[]'::jsonb),
    'recentShifts', coalesce((
      SELECT jsonb_agg(ts_internal.shift_view(s, cl.name) ORDER BY s.closed_at DESC, s.id)
      FROM public.shifts s JOIN public.clubs cl ON cl.id = s.club_id
      WHERE cl.company_id = me.company_id AND s.status = 'CLOSED' AND s.closed_at >= v_now - 7 * 86400000::bigint
    ), '[]'::jsonb));
END
$$;

/** ClubDetails of a club of the owner's company. */
CREATE FUNCTION public.owner_club(p_club_id text, p_now bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me public.owners := ts_internal.require_owner();
  c public.clubs := ts_internal.require_club(me.company_id, p_club_id);
  v_now bigint := coalesce(p_now, ts_internal.now_ms());
  v_snap jsonb := ts_internal.club_snapshot(c);
  v_tables jsonb := v_snap -> 'tables';
  v_today text := ts_internal.local_day(v_now, c.timezone);
  v_first text := ts_internal.add_days(v_today, -29);
  v_tomorrow bigint := ts_internal.day_start(ts_internal.add_days(v_today, 1), c.timezone);
BEGIN
  RETURN jsonb_build_object(
    'club', ts_internal.club_summary(c, v_snap, v_now),
    'days', (
      SELECT jsonb_agg(
               jsonb_build_object('day', d.day, 'alerts', coalesce(x.alerts, 0))
               || (ts_internal.period_json(x.billed, x.games, x.played, x.paid_total, x.paid_cash, x.paid_card, x.paid_qr,
                                           x.refunded, x.checks_paid, x.discounts, x.cancelled) - 'averageCheck')
               ORDER BY d.day)
      FROM (SELECT to_char(g, 'YYYY-MM-DD') AS day
            FROM generate_series(v_first::date, v_today::date, interval '1 day') g) d
      LEFT JOIN (
        SELECT ds.day, sum(ds.revenue) AS billed, sum(ds.games) AS games, sum(ds.played_seconds) AS played,
               sum(ds.paid_total) AS paid_total, sum(ds.paid_cash) AS paid_cash, sum(ds.paid_card) AS paid_card,
               sum(ds.paid_qr) AS paid_qr, sum(ds.refunded) AS refunded, sum(ds.checks_paid) AS checks_paid,
               sum(ds.discounts) AS discounts, sum(ds.cancelled_games) AS cancelled, sum(ds.alerts)::bigint AS alerts
        FROM public.daily_stats ds
        WHERE ds.club_id = c.id AND ds.day >= v_first AND ds.day <= v_today
        GROUP BY ds.day
      ) x ON x.day = d.day),
    'hours', ts_internal.hour_load(c.id, c.timezone, v_now,
                                   ts_internal.day_start(ts_internal.add_days(v_today, -6), c.timezone), v_tomorrow),
    'tables', ts_internal.table_stats(c.id, c.timezone, v_tables, v_now,
                                      ts_internal.day_start(v_first, c.timezone), v_tomorrow),
    'alerts',
      coalesce((SELECT jsonb_agg(ts_internal.alert_view(a, c.name, v_tables) ORDER BY a.at DESC, a.id)
                FROM public.alerts a WHERE a.club_id = c.id AND a.resolved_at IS NULL), '[]'::jsonb)
      || coalesce((SELECT jsonb_agg(ts_internal.alert_view(x.a, c.name, v_tables) ORDER BY x.ord)
                   FROM (SELECT a, row_number() OVER (ORDER BY a.resolved_at DESC, a.id) AS ord
                         FROM public.alerts a WHERE a.club_id = c.id AND a.resolved_at IS NOT NULL
                         ORDER BY a.resolved_at DESC, a.id LIMIT 20) x), '[]'::jsonb),
    'recentSessions', coalesce((
      SELECT jsonb_agg(ts_internal.session_view(x.s, x.check_number, v_tables) ORDER BY x.ord)
      FROM (SELECT s, ch.number AS check_number, row_number() OVER (ORDER BY s.requested_at DESC, s.id) AS ord
            FROM public.sessions s LEFT JOIN public.checks ch ON ch.id = s.check_id
            WHERE s.club_id = c.id ORDER BY s.requested_at DESC, s.id LIMIT 20) x), '[]'::jsonb),
    'shifts', coalesce((
      SELECT jsonb_agg(ts_internal.shift_view(s, c.name)
                       ORDER BY CASE WHEN s.status = 'OPEN' THEN 0 ELSE 1 END, coalesce(s.closed_at, s.opened_at) DESC,
                                s.opened_at DESC, s.id)
      FROM public.shifts s
      WHERE s.club_id = c.id AND (s.status = 'OPEN' OR s.closed_at >= v_now - 30 * 86400000::bigint)), '[]'::jsonb),
    'outages', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'clubId', o.club_id, 'startedAt', o.started_at,
                                          'endedAt', o.ended_at, 'critical', coalesce(o.critical, 0) = 1,
                                          'pausedGames', coalesce(o.paused_games, 0))
                       ORDER BY o.started_at DESC, o.id)
      FROM public.power_outages o
      WHERE o.club_id = c.id AND o.started_at >= v_now - 30 * 86400000::bigint), '[]'::jsonb),
    'settings', v_snap);
END
$$;

/** CloudSessionView[] of games requested on a local day (NULL = today in the club's zone), newest first. */
CREATE FUNCTION public.owner_club_sessions(p_club_id text, p_day text DEFAULT NULL, p_now bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me public.owners := ts_internal.require_owner();
  c public.clubs := ts_internal.require_club(me.company_id, p_club_id);
  v_day text := coalesce(p_day, ts_internal.local_day(coalesce(p_now, ts_internal.now_ms()), c.timezone));
  v_tables jsonb;
  v_from bigint;
  v_to bigint;
BEGIN
  IF NOT ts_internal.is_valid_day(v_day) THEN
    RAISE EXCEPTION 'BAD_REQUEST' USING ERRCODE = '22023', HINT = 'day должен быть датой YYYY-MM-DD';
  END IF;
  v_tables := ts_internal.club_snapshot(c) -> 'tables';
  v_from := ts_internal.day_start(v_day, c.timezone);
  v_to := ts_internal.day_start(ts_internal.add_days(v_day, 1), c.timezone);
  RETURN coalesce((
    SELECT jsonb_agg(ts_internal.session_view(s, ch.number, v_tables) ORDER BY s.requested_at DESC, s.id)
    FROM public.sessions s LEFT JOIN public.checks ch ON ch.id = s.check_id
    WHERE s.club_id = c.id AND s.requested_at >= v_from AND s.requested_at < v_to), '[]'::jsonb);
END
$$;

/** PushSettingsView of the signed-in owner. */
CREATE FUNCTION public.owner_push_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me public.owners := ts_internal.require_owner();
BEGIN
  RETURN ts_internal.push_settings(me.id);
END
$$;

/**
 * Replaces the owner's notification rules (UpdatePushRulesRequest.rules: PushRule[];
 * `{ "rules": [...] }` is accepted too) and returns PushSettingsView.
 * The first rule for a (club, kind) wins, like saveRules().
 */
CREATE FUNCTION public.owner_set_push_rules(p_rules jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me public.owners := ts_internal.require_owner();
  v_rules jsonb := p_rules;
  r jsonb;
BEGIN
  IF jsonb_typeof(v_rules) = 'object' AND v_rules ? 'rules' THEN
    v_rules := v_rules -> 'rules';
  END IF;
  IF v_rules IS NULL OR jsonb_typeof(v_rules) <> 'array' THEN
    RAISE EXCEPTION 'BAD_REQUEST' USING ERRCODE = '22023', HINT = 'rules: нужен список правил';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(v_rules) LOOP
    IF jsonb_typeof(r) <> 'object' OR jsonb_typeof(r -> 'kind') IS DISTINCT FROM 'string'
       OR NOT (r ? 'clubId') OR jsonb_typeof(r -> 'clubId') NOT IN ('string', 'null')
       OR jsonb_typeof(r -> 'enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'BAD_REQUEST' USING ERRCODE = '22023', HINT = 'Правило: нужны kind, clubId и enabled';
    END IF;
    IF NOT ts_internal.is_push_kind(r ->> 'kind') THEN
      RAISE EXCEPTION 'PUSH_KIND' USING ERRCODE = '22023', HINT = format('Неизвестный вид уведомления: %s', r ->> 'kind');
    END IF;
    IF jsonb_typeof(r -> 'clubId') = 'string' THEN
      PERFORM ts_internal.require_club(me.company_id, r ->> 'clubId');
    END IF;
  END LOOP;

  DELETE FROM public.push_rules WHERE owner_id = me.id;
  INSERT INTO public.push_rules (owner_id, club_id, kind, enabled)
  SELECT DISTINCT ON (coalesce(e.r ->> 'clubId', ''), e.r ->> 'kind')
         me.id, coalesce(e.r ->> 'clubId', ''), e.r ->> 'kind', CASE WHEN (e.r -> 'enabled') = 'true'::jsonb THEN 1 ELSE 0 END
  FROM jsonb_array_elements(v_rules) WITH ORDINALITY AS e(r, pos)
  ORDER BY coalesce(e.r ->> 'clubId', ''), e.r ->> 'kind', e.pos;

  RETURN ts_internal.push_settings(me.id);
END
$$;

-- Only signed-in users (and the service role) may call the API functions.
REVOKE ALL ON FUNCTION public.current_owner_id(), public.my_company_id(), public.owner_me(),
  public.owner_overview(bigint), public.owner_club(text, bigint), public.owner_club_sessions(text, text, bigint),
  public.owner_push_settings(), public.owner_set_push_rules(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_owner_id(), public.my_company_id(), public.owner_me(),
  public.owner_overview(bigint), public.owner_club(text, bigint), public.owner_club_sessions(text, text, bigint),
  public.owner_push_settings(), public.owner_set_push_rules(jsonb)
  TO authenticated, service_role;

-- Helpers: nobody but the definer (the functions above run as their owner).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ts_internal FROM PUBLIC;

-- ===========================================================================
-- 5. Realtime: owners subscribe to new alerts (RLS applies)
-- ===========================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
