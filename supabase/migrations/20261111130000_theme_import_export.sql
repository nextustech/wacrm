-- Lets every member of a workspace see a theme once it's installed there,
-- even when the theme itself is private (e.g. imported from a file rather
-- than published to the public marketplace). Without this, only the
-- importing user could see the custom theme's name/tokens via getActiveTheme.
DROP POLICY IF EXISTS "themes visible to installing workspace" ON public.themes;
CREATE POLICY "themes visible to installing workspace" ON public.themes FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.theme_installations ti
      JOIN public.workspace_members wm ON wm.workspace_id = ti.workspace_id
      WHERE ti.theme_id = themes.id AND wm.user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
