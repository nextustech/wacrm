-- LINE Messaging API channel: one row per connected LINE Official Account.
--
-- Same shape as `viber_accounts`, with one extra secret: LINE signs every
-- webhook delivery with the *channel secret* (base64 HMAC-SHA256 in
-- `X-Line-Signature`), while outbound calls authenticate with a separate
-- *channel access token*. Both are stored encrypted at rest.

CREATE TABLE IF NOT EXISTS public.line_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- LINE's own bot user id (Uxxxxxxxx), from /v2/bot/info.
  bot_user_id text NOT NULL,
  basic_id text,
  display_name text,
  picture_url text,
  channel_secret_ciphertext text NOT NULL,
  channel_access_token_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'connected',
  status_reason text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, bot_user_id)
);

CREATE INDEX IF NOT EXISTS idx_line_accounts_workspace ON public.line_accounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_line_accounts_bot ON public.line_accounts(bot_user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.line_accounts TO authenticated;
GRANT ALL ON public.line_accounts TO service_role;

ALTER TABLE public.line_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "line_accounts by workspace member" ON public.line_accounts;
CREATE POLICY "line_accounts by workspace member"
  ON public.line_accounts
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP TRIGGER IF EXISTS trg_line_accounts_updated ON public.line_accounts;
CREATE TRIGGER trg_line_accounts_updated
  BEFORE UPDATE ON public.line_accounts
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
