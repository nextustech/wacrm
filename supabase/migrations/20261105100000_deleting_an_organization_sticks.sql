-- Deleting an organization did not stick, and deleting an account did nothing.
--
-- `ensure_personal_organization()` provisions whenever the caller has NO
-- organization membership. That is the right rule on first login, but the app
-- calls it from the `_authenticated` guard on every navigation — so the moment
-- an owner deleted their only organization, the redirect to /dashboard minted a
-- replacement with the same generated name (`<email>'s Workspace`). The data
-- really was gone, but the organization appeared to come back, and a tenant a
-- superadmin deleted reappeared as soon as its owner next signed in.
--
-- Fix: remember that a user has already had their personal organization, and
-- never auto-provision a second time. A user who deletes their last
-- organization now lands on a "create an organization" screen instead.

-- 1) The marker.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS personal_org_provisioned_at timestamptz;

COMMENT ON COLUMN public.profiles.personal_org_provisioned_at IS
  'When this user first received a personal organization. Set once; its presence stops ensure_personal_organization() from auto-provisioning again after the user deletes their organizations.';

-- Backfill: anyone who already belongs to an organization has clearly had one,
-- so mark them now. Without this, an existing user who deletes their only
-- organization before their next provisioning call would still get a
-- replacement — exactly the bug being fixed.
UPDATE public.profiles p
SET personal_org_provisioned_at = COALESCE(p.personal_org_provisioned_at, now())
WHERE p.personal_org_provisioned_at IS NULL
  AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = p.id);

-- 2) Auto-provision only once.
--
-- Returns NULL when the user has no organization and has already had one. The
-- caller treats that as "send them to create one" rather than an error.
CREATE OR REPLACE FUNCTION public.ensure_personal_organization(_user_id uuid, _email text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_workspace_id uuid;
  v_plan_id uuid;
  v_base_slug text;
  v_slug text;
  v_name text;
  v_provisioned timestamptz;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ensure_personal_org:' || _user_id::text, 0));

  SELECT organization_id INTO v_org_id
  FROM public.organization_members
  WHERE user_id = _user_id
  ORDER BY joined_at ASC
  LIMIT 1;

  IF v_org_id IS NULL THEN
    SELECT personal_org_provisioned_at INTO v_provisioned
    FROM public.profiles WHERE id = _user_id;

    -- Already had one and deleted it. Honour that instead of resurrecting it.
    IF v_provisioned IS NOT NULL THEN
      RETURN NULL;
    END IF;

    v_base_slug := COALESCE(
      NULLIF(regexp_replace(lower(split_part(COALESCE(_email, ''), '@', 1)), '[^a-z0-9]+', '-', 'g'), ''),
      'user-' || substr(_user_id::text, 1, 8)
    );
    v_base_slug := regexp_replace(v_base_slug, '(^-|-$)', '', 'g');
    IF v_base_slug = '' THEN
      v_base_slug := 'user-' || substr(_user_id::text, 1, 8);
    END IF;
    v_slug := v_base_slug || '-' || substr(_user_id::text, 1, 6);
    v_name := CASE
      WHEN _email IS NOT NULL AND _email <> '' THEN split_part(_email, '@', 1) || '''s Workspace'
      ELSE 'My Workspace'
    END;

    INSERT INTO public.organizations (name, slug, owner_id, billing_email)
    VALUES (v_name, v_slug, _user_id, _email)
    RETURNING id INTO v_org_id;

    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES (v_org_id, _user_id, 'owner')
    ON CONFLICT DO NOTHING;
  ELSE
    SELECT name INTO v_name FROM public.organizations WHERE id = v_org_id;
    v_name := COALESCE(v_name, 'My Workspace');
  END IF;

  -- Mark on every successful resolution, not only on the insert: a user who
  -- already had an organization before this migration must not be treated as
  -- never-provisioned the first time they delete it.
  UPDATE public.profiles
  SET personal_org_provisioned_at = now()
  WHERE id = _user_id AND personal_org_provisioned_at IS NULL;

  SELECT id INTO v_workspace_id
  FROM public.workspaces
  WHERE organization_id = v_org_id AND owner_id = _user_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_workspace_id IS NULL THEN
    -- Adopt the workspace handle_new_user() created at signup (no organization
    -- yet) instead of creating a second one.
    SELECT id INTO v_workspace_id
    FROM public.workspaces
    WHERE organization_id IS NULL AND owner_id = _user_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_workspace_id IS NOT NULL THEN
      UPDATE public.workspaces SET organization_id = v_org_id WHERE id = v_workspace_id;
    ELSE
      v_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
      v_slug := trim(both '-' from v_slug) || '-' || substr(v_org_id::text, 1, 6);
      INSERT INTO public.workspaces (name, slug, owner_id, organization_id, plan)
      VALUES (v_name, v_slug, _user_id, v_org_id, 'free')
      RETURNING id INTO v_workspace_id;
    END IF;
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
  VALUES (v_workspace_id, _user_id, 'owner', 'active')
  ON CONFLICT DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE organization_id = v_org_id) THEN
    SELECT id INTO v_plan_id FROM public.plans WHERE code = 'free' AND is_active = true LIMIT 1;
    IF v_plan_id IS NOT NULL THEN
      INSERT INTO public.subscriptions (
        organization_id, plan_id, status, seats,
        current_period_start, current_period_end, metadata
      ) VALUES (
        v_org_id, v_plan_id, 'active', 1,
        now(), now() + interval '100 years', jsonb_build_object('provisioned', true)
      ) ON CONFLICT (organization_id) DO NOTHING;
    END IF;
  END IF;

  RETURN v_org_id;
END;
$function$;

-- 3) Explicit creation, for the "create an organization" screen.
--
-- Mirrors the provisioning body but takes the name from the user and always
-- creates. SECURITY DEFINER for the same reason ensure_personal_organization is:
-- the owner's first membership row cannot be inserted under RLS until the
-- organization exists, and both have to land together.
CREATE OR REPLACE FUNCTION public.create_organization_for_user(
  _user_id uuid,
  _name text,
  _email text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_workspace_id uuid;
  v_plan_id uuid;
  v_name text;
  v_slug text;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  v_name := NULLIF(btrim(COALESCE(_name, '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ensure_personal_org:' || _user_id::text, 0));

  v_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  IF v_slug = '' THEN
    v_slug := 'org';
  END IF;
  v_slug := v_slug || '-' || substr(gen_random_uuid()::text, 1, 6);

  INSERT INTO public.organizations (name, slug, owner_id, billing_email)
  VALUES (v_name, v_slug, _user_id, _email)
  RETURNING id INTO v_org_id;

  INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES (v_org_id, _user_id, 'owner')
  ON CONFLICT DO NOTHING;

  UPDATE public.profiles
  SET personal_org_provisioned_at = COALESCE(personal_org_provisioned_at, now())
  WHERE id = _user_id;

  INSERT INTO public.workspaces (name, slug, owner_id, organization_id, plan)
  VALUES (v_name, v_slug, _user_id, v_org_id, 'free')
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
  VALUES (v_workspace_id, _user_id, 'owner', 'active')
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_plan_id FROM public.plans WHERE code = 'free' AND is_active = true LIMIT 1;
  IF v_plan_id IS NOT NULL THEN
    INSERT INTO public.subscriptions (
      organization_id, plan_id, status, seats,
      current_period_start, current_period_end, metadata
    ) VALUES (
      v_org_id, v_plan_id, 'active', 1,
      now(), now() + interval '100 years', jsonb_build_object('provisioned', true)
    ) ON CONFLICT (organization_id) DO NOTHING;
  END IF;

  RETURN v_org_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_organization_for_user(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- 4) Account deletion was blocked by a foreign key nobody cleared.
--
-- `pm_client_update_rules.created_by` references auth.users ON DELETE RESTRICT,
-- and the deletion prep did not touch it, so `auth.admin.deleteUser` failed for
-- any user who had ever configured a client-update rule. The rule is personal
-- configuration tied to its author, so it goes with them.
CREATE OR REPLACE FUNCTION public.prepare_platform_user_deletion(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_successor uuid;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  DELETE FROM public.pm_client_update_rules WHERE created_by = _user_id;

  FOR r IN SELECT id FROM public.organizations WHERE owner_id = _user_id LOOP
    SELECT om.user_id INTO v_successor
    FROM public.organization_members om
    WHERE om.organization_id = r.id AND om.user_id <> _user_id
    ORDER BY CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, om.joined_at
    LIMIT 1;

    IF v_successor IS NULL THEN
      DELETE FROM public.organizations WHERE id = r.id;
    ELSE
      UPDATE public.organizations SET owner_id = v_successor WHERE id = r.id;
      UPDATE public.organization_members
      SET role = 'owner'
      WHERE organization_id = r.id AND user_id = v_successor;
    END IF;
  END LOOP;

  FOR r IN SELECT id FROM public.workspaces WHERE owner_id = _user_id LOOP
    SELECT wm.user_id INTO v_successor
    FROM public.workspace_members wm
    WHERE wm.workspace_id = r.id AND wm.user_id <> _user_id AND wm.status = 'active'
    ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
             wm.created_at
    LIMIT 1;

    IF v_successor IS NULL THEN
      DELETE FROM public.workspaces WHERE id = r.id;
    ELSE
      UPDATE public.workspaces SET owner_id = v_successor WHERE id = r.id;
      UPDATE public.workspace_members
      SET role = 'owner'
      WHERE workspace_id = r.id AND user_id = v_successor;
    END IF;
  END LOOP;
END;
$$;
