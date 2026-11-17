-- ============================================================================
--  WACRM — Super administrator recovery patch
-- ============================================================================
--  Use this when an installation is running but nobody can reach the Super
--  Admin area, because the database has no `superadmin` role in it. Builds
--  before v7.2.3 had no working way to create that first administrator.
--
--  HOW TO RUN
--    1. Supabase Dashboard → SQL Editor → New query.
--    2. Paste this whole file.
--    3. Edit the two values in the CONFIGURE block below.
--    4. Run. Read the NOTICE messages at the bottom of the result panel —
--       they say exactly what was done.
--
--  WHAT IT DOES
--    * A super admin already exists  → changes NOTHING and says so.
--    * The email already has an account → promotes that account. Its password
--      is NOT changed; sign in with the password you already use.
--    * The email is new → creates a confirmed account with the password below
--      and makes it super admin.
--
--  It is safe to run more than once: after the first successful run a super
--  admin exists, so every later run does nothing.
--
--  ⚠  SAVE THE CREDENTIALS. This account controls the whole installation.
--     Store the email and password in your password manager before you close
--     this page, and delete the password from this file afterwards.
-- ============================================================================

DO $$
DECLARE
  -- ╔══════════════════════ CONFIGURE ══════════════════════╗
  v_email    text := 'owner@example.com';   -- your admin email
  v_password text := 'ChangeThisNow!2026';  -- min 10 chars, use a strong one
  -- ╚═══════════════════════════════════════════════════════╝
  v_user_id  uuid;
  v_existing uuid;
BEGIN
  v_email := lower(trim(v_email));

  -- 1. Already have an administrator? Then there is nothing to recover.
  SELECT ur.user_id INTO v_existing
    FROM public.user_roles ur
   WHERE ur.role::text = 'superadmin'
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE NOTICE '✔ A super administrator already exists (user %). Nothing was changed.', v_existing;
    RETURN;
  END IF;

  IF v_email = 'owner@example.com' THEN
    RAISE EXCEPTION 'Edit v_email in the CONFIGURE block before running this patch.';
  END IF;
  IF length(v_password) < 10 THEN
    RAISE EXCEPTION 'Choose a password of at least 10 characters.';
  END IF;

  -- 2. Does the address already have an account? Then promote it, untouched.
  SELECT u.id INTO v_user_id FROM auth.users u WHERE lower(u.email) = v_email LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    RAISE NOTICE '→ % already has an account; promoting it. Its password is unchanged.', v_email;
  ELSE
    -- 3. No account: create a confirmed one. `auth.identities` is required or
    --    GoTrue will not accept an email/password sign-in for this user.
    v_user_id := gen_random_uuid();

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
      v_email, extensions.crypt(v_password, extensions.gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', 'Super Administrator', 'recovered', true),
      now(), now()
    );

    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_user_id, v_user_id::text,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true),
      'email', now(), now(), now()
    );

    RAISE NOTICE '→ Created a new account for %.', v_email;
  END IF;

  -- 4. A profile row, if the app's own trigger did not already make one.
  INSERT INTO public.profiles (id, email, display_name)
  SELECT v_user_id, v_email, 'Super Administrator'
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user_id);

  -- 5. The role itself.
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, 'superadmin'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RAISE NOTICE '════════════════════════════════════════════════════════════';
  RAISE NOTICE '✔ Super administrator ready.';
  RAISE NOTICE '   email : %', v_email;
  RAISE NOTICE '   id    : %', v_user_id;
  RAISE NOTICE '   SAVE THESE CREDENTIALS NOW — this account owns the install.';
  RAISE NOTICE '   Sign in at  /auth  and open  Admin → Super Admin.';
  RAISE NOTICE '════════════════════════════════════════════════════════════';
END $$;

-- Confirm the result (should list exactly one row):
SELECT u.email, ur.role, ur.created_at
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
 WHERE ur.role::text = 'superadmin';
