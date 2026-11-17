ALTER TABLE public.white_label_configs
  ADD COLUMN IF NOT EXISTS dark_sidebar_background text,
  ADD COLUMN IF NOT EXISTS dark_sidebar_foreground text,
  ADD COLUMN IF NOT EXISTS dark_sidebar_accent     text,
  ADD COLUMN IF NOT EXISTS dark_sidebar_border     text,
  ADD COLUMN IF NOT EXISTS dark_dashboard_background text,
  ADD COLUMN IF NOT EXISTS dark_dashboard_accent     text;

NOTIFY pgrst, 'reload schema';
