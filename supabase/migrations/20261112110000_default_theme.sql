-- A mandatory, always-available "Default" theme. It can be activated (resets
-- a workspace back to the baseline look) and exported, but never removed —
-- the partial unique index keeps exactly one row flagged as the default.
ALTER TABLE public.themes
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_themes_single_default
  ON public.themes (is_default) WHERE is_default;

INSERT INTO public.themes (slug, name, description, tokens, publisher_name, is_public, is_featured, is_default)
VALUES (
  'default',
  'Default',
  'The built-in baseline look every workspace starts with. Always available to activate or export.',
  '{
    "--primary": "oklch(0.44 0.07 175)",
    "--primary-foreground": "oklch(1 0 0)",
    "--secondary": "oklch(0.966 0.002 20)",
    "--secondary-foreground": "oklch(0.194 0.007 240)",
    "--accent": "#25d366",
    "--accent-foreground": "oklch(1 0 0)",
    "--background": "oklch(100% 0 0)",
    "--foreground": "oklch(0.083 0.003 25)",
    "--border": "oklch(94% 0 0)",
    "--sidebar": "oklch(0.083 0.003 25)",
    "--sidebar-foreground": "oklch(0.966 0.002 20)",
    "--sidebar-accent": "oklch(0.194 0.007 240)",
    "--sidebar-accent-foreground": "oklch(0.966 0.002 20)",
    "--sidebar-border": "oklch(0.20 0.007 240)",
    "--radius": "0.75rem"
  }'::jsonb,
  'wacrm',
  true,
  true,
  true
)
ON CONFLICT (slug) DO UPDATE SET is_default = true, is_public = true, is_featured = true;

NOTIFY pgrst, 'reload schema';
