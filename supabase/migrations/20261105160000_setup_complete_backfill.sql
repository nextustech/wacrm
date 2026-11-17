-- The first-run gate is moving from "does a super admin exist" to "is setup
-- complete", so that a half-finished wizard cannot be abandoned half-way and
-- leave an app running on defaults.
--
-- Installations that created their super admin outside the wizard never wrote
-- the `setup_complete` flag. Without this backfill the stricter gate would
-- herd every one of those live, working deployments into the setup wizard —
-- whose later steps overwrite branding, localization, SMTP and SaaS settings
-- wholesale. So: an installation that already has a super admin is declared
-- set up, once, here.
--
-- A genuinely fresh database runs this migration before any admin exists, so
-- the guard below is false and nothing is written — the wizard still runs.

-- 1. No flag row at all, but an admin exists → it is an existing installation.
INSERT INTO public.settings (scope, key, value, organization_id, workspace_id, user_id)
SELECT 'platform',
       'setup_complete',
       jsonb_build_object('complete', true, 'completed_at', now(), 'backfilled', true),
       NULL,
       NULL,
       NULL
WHERE EXISTS (SELECT 1 FROM public.user_roles WHERE role::text = 'superadmin')
  AND NOT EXISTS (
    SELECT 1
      FROM public.settings
     WHERE scope::text = 'platform'
       AND key = 'setup_complete'
       AND organization_id IS NULL
       AND workspace_id IS NULL
       AND user_id IS NULL
  );

-- 2. A flag row exists but was never set to complete, and an admin exists.
UPDATE public.settings s
   SET value = s.value || jsonb_build_object('complete', true, 'completed_at', now(), 'backfilled', true),
       updated_at = now()
 WHERE s.scope::text = 'platform'
   AND s.key = 'setup_complete'
   AND s.organization_id IS NULL
   AND s.workspace_id IS NULL
   AND s.user_id IS NULL
   AND coalesce((s.value ->> 'complete')::boolean, false) = false
   AND EXISTS (SELECT 1 FROM public.user_roles WHERE role::text = 'superadmin');
