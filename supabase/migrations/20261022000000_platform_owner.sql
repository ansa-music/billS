-- TS on Supabase: the first platform owner by e-mail, and a demo client for the public cabinet.
--
--  * public.ts_make_platform_owner(email) / public.ts_make_platform_tech(email): a platform_staff
--    row for a Supabase Auth user (Authentication → Users → Add user). The Edge Function `platform`
--    accepts that user's Supabase JWT (checked by the Auth API) besides OWNER-/TECH- key sessions.
--  * public.ts_seed_demo_cloud(manager_email): the demo client «Демо-сеть» — manager, two branches
--    with HUBs, staff with short keys, and a 7-day trial license. A license cannot be signed in SQL:
--    it is stored with signed = '' and the Edge Functions (platform, owner, sync) sign it with
--    LICENSE_SIGNING_KEY on their next request (apps/cloud/src/license.ts signPendingLicenses).
-- All three: SECURITY DEFINER, EXECUTE for service_role only (deploy.yml runs them with the
-- Management API; the SQL Editor runs as postgres). Idempotent.

ALTER TABLE public.platform_staff
  ADD COLUMN auth_user_id uuid UNIQUE NULL REFERENCES auth.users (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX ux_platform_staff_email ON public.platform_staff (lower(email)) WHERE email IS NOT NULL;

/** n strong random bytes (from gen_random_uuid, skipping its version/variant bytes). */
CREATE FUNCTION ts_internal.random_bytes(n integer) RETURNS bytea
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  out bytea := '\x'::bytea;
  u bytea;
  i integer;
BEGIN
  WHILE length(out) < n LOOP
    u := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    FOR i IN 0..15 LOOP
      IF i <> 6 AND i <> 8 AND length(out) < n THEN
        out := out || substring(u FROM i + 1 FOR 1);
      END IF;
    END LOOP;
  END LOOP;
  RETURN out;
END
$$;

CREATE FUNCTION ts_internal.sha256_hex(t text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex')
$$;

/** A long key like formatAccessKey (packages/domain auth.ts): PREFIX-XXXX-XXXX-XXXX-XXXX. */
CREATE FUNCTION ts_internal.long_key(prefix text) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := ts_internal.random_bytes(16);
  k text := prefix;
  i integer;
BEGIN
  FOR i IN 0..15 LOOP
    IF i % 4 = 0 THEN k := k || '-'; END IF;
    k := k || substr(alphabet, (get_byte(b, i) % 31) + 1, 1);
  END LOOP;
  RETURN k;
END
$$;

CREATE FUNCTION ts_internal.make_platform_staff(p_email text, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id text;
BEGIN
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Неверный e-mail: %', p_email USING ERRCODE = '22023';
  END IF;
  IF p_role NOT IN ('owner', 'tech') THEN
    RAISE EXCEPTION 'Роль платформы: owner или tech' USING ERRCODE = '22023';
  END IF;
  SELECT s.id INTO v_id FROM public.platform_staff s WHERE lower(s.email) = v_email;
  IF v_id IS NULL THEN
    v_id := gen_random_uuid()::text;
    INSERT INTO public.platform_staff (id, name, role, email, is_active, created_at)
    VALUES (v_id, split_part(v_email, '@', 1), p_role, v_email, 1, ts_internal.now_ms());
  ELSE
    UPDATE public.platform_staff SET role = p_role, is_active = 1 WHERE id = v_id;
  END IF;
  UPDATE public.platform_staff s SET auth_user_id = u.id
  FROM auth.users u
  WHERE s.id = v_id AND s.auth_user_id IS NULL AND lower(u.email) = v_email AND ts_internal.auth_email_trusted(to_jsonb(u));
  -- Platform people are part of every HUB's access package.
  UPDATE public.companies SET access_version = access_version + 1;
  RETURN v_id;
END
$$;

CREATE FUNCTION public.ts_make_platform_owner(p_email text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT ts_internal.make_platform_staff(p_email, 'owner')
$$;

CREATE FUNCTION public.ts_make_platform_tech(p_email text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT ts_internal.make_platform_staff(p_email, 'tech')
$$;

/**
 * The demo client. Returns {created, companyId, managerEmail, managerKey?, hubs?: [{hubId, clubId, apiKey}]};
 * keys only when created now (a second call returns created = false and no secrets).
 */
CREATE FUNCTION public.ts_seed_demo_cloud(p_manager_email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := lower(btrim(coalesce(nullif(btrim(p_manager_email), ''), 'demo-manager@ts.demo')));
  v_now bigint := ts_internal.now_ms();
  v_company text;
  v_owner text;
  v_mgr text;
  v_hubs jsonb := '[]'::jsonb;
  v_hub_ids jsonb := '[]'::jsonb;
  v_club text;
  v_hub text;
  v_key text;
  v_staff text;
  b record;
  st record;
  v_payload jsonb;
BEGIN
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Неверный e-mail: %', p_manager_email USING ERRCODE = '22023';
  END IF;
  SELECT o.company_id INTO v_company FROM public.owners o WHERE lower(o.email) = v_email;
  IF v_company IS NOT NULL THEN
    RETURN jsonb_build_object('created', false, 'companyId', v_company, 'managerEmail', v_email);
  END IF;

  v_company := gen_random_uuid()::text;
  v_owner := gen_random_uuid()::text;
  INSERT INTO public.companies (id, name, created_at) VALUES (v_company, 'Демо-сеть', v_now);
  -- No password: the manager signs up through Supabase Auth with this e-mail (linked by trigger).
  INSERT INTO public.owners (id, company_id, email, name, password_hash, created_at)
  VALUES (v_owner, v_company, v_email, 'Управляющий (демо)', '!', v_now);
  v_mgr := ts_internal.long_key('MGR');
  INSERT INTO public.manager_keys (id, owner_id, key_hash, prefix, label, created_at)
  VALUES (gen_random_uuid()::text, v_owner, ts_internal.sha256_hex(v_mgr), split_part(v_mgr, '-', 1) || '-' || split_part(v_mgr, '-', 2), 'Демо', v_now);

  FOR b IN SELECT * FROM (VALUES (1, 'Демо: Центр'), (2, 'Демо: Север')) AS t(n, name) ORDER BY n LOOP
    v_club := gen_random_uuid()::text;
    v_hub := 'hub-demo-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    v_key := rtrim(translate(encode(ts_internal.random_bytes(32), 'base64'), E'+/\n', '-_'), '=');
    INSERT INTO public.clubs (id, company_id, name, timezone, currency, created_at)
    VALUES (v_club, v_company, b.name, 'Asia/Almaty', 'KZT', v_now + b.n);
    INSERT INTO public.hubs (id, club_id, name, api_key_hash, created_at, settings_version)
    VALUES (v_hub, v_club, 'HUB ' || b.name, ts_internal.sha256_hex(v_key), v_now + b.n, 0);
    v_hubs := v_hubs || jsonb_build_array(jsonb_build_object('hubId', v_hub, 'clubId', v_club, 'apiKey', v_key));
    v_hub_ids := v_hub_ids || to_jsonb(v_hub);
    FOR st IN
      SELECT * FROM (VALUES
        (1, 1, 'Старший смены', '["senior"]', '260417'),
        (1, 2, 'Кассир', '["cashier"]', '318540'),
        (1, 3, 'Официант', '["waiter"]', '527193'),
        (1, 4, 'Официант-кассир', '["cashier","waiter"]', '640285'),
        (2, 1, 'Официант-кассир', '["cashier","waiter"]', '640285')
      ) AS t(branch, n, name, roles, key)
      WHERE branch = b.n ORDER BY n
    LOOP
      v_staff := gen_random_uuid()::text;
      INSERT INTO public.club_staff (id, club_id, company_id, name, roles, is_active, created_at, updated_at)
      VALUES (v_staff, v_club, v_company, st.name, st.roles, 1, v_now + st.n, v_now + st.n);
      INSERT INTO public.club_keys (id, staff_id, club_id, kind, key_hash, prefix, label, created_at)
      VALUES (gen_random_uuid()::text, v_staff, v_club, 'short',
              ts_internal.sha256_hex('ts-short-key:v1:' || v_club || ':' || st.key), '••••' || right(st.key, 2), 'Демо', v_now);
    END LOOP;
  END LOOP;

  -- LicensePayload (packages/domain license.ts), signed later by the Edge Functions.
  v_payload := jsonb_build_object(
    'v', 1, 'id', gen_random_uuid()::text, 'companyId', v_company, 'companyName', 'Демо-сеть', 'plan', 'trial',
    'issuedAt', v_now, 'validFrom', v_now, 'validUntil', v_now + 7 * 86400000, 'maxClubs', 2,
    'maxTables', NULL, 'maxStaff', NULL, 'modules', jsonb_build_object('bar', true, 'cloud', true, 'hardware', true),
    'hubIds', v_hub_ids, 'blocked', false);
  INSERT INTO public.licenses (id, company_id, seq, payload_json, signed, issued_at, issued_by)
  VALUES (v_payload ->> 'id', v_company, 1, v_payload::text, '', v_now, 'ts_seed_demo_cloud');

  RETURN jsonb_build_object('created', true, 'companyId', v_company, 'managerEmail', v_email, 'managerKey', v_mgr, 'hubs', v_hubs);
END
$$;

REVOKE ALL ON FUNCTION public.ts_make_platform_owner(text), public.ts_make_platform_tech(text), public.ts_seed_demo_cloud(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ts_make_platform_owner(text), public.ts_make_platform_tech(text), public.ts_seed_demo_cloud(text)
  TO service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ts_internal FROM PUBLIC, anon, authenticated;
