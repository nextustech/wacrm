ALTER TABLE public.white_label_configs
  ADD COLUMN IF NOT EXISTS font_weight_sans text,
  ADD COLUMN IF NOT EXISTS font_weight_heading text,
  ADD COLUMN IF NOT EXISTS font_weight_mono text;

NOTIFY pgrst, 'reload schema';
