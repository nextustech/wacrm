-- Each custom theme now stores its full white-label config snapshot (colors,
-- typography, layout, default mode, logos, login page, email branding — see
-- src/lib/themes/theme-config-fields.ts for the exact field list), not just
-- a bag of CSS tokens. `tokens` stays as the derived CSS-var view used for
-- preview swatches and export.
ALTER TABLE public.themes
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

NOTIFY pgrst, 'reload schema';
