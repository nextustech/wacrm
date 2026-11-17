-- Viber Bot channel: one row per connected Viber bot.
--
-- Mirrors `telegram_accounts`: the workspace pastes the bot's auth token from
-- the Viber Admin Panel, we validate it with `get_account_info`, register the
-- webhook, and keep the token encrypted at rest. Viber signs every webhook
-- delivery with that same token (HMAC-SHA256 in `X-Viber-Content-Signature`),
-- so no separate webhook secret is stored.

CREATE TABLE IF NOT EXISTS public.viber_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  bot_id text NOT NULL,
  bot_name text,
  bot_uri text,
  bot_icon_url text,
  auth_token_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'connected',
  status_reason text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_viber_accounts_workspace ON public.viber_accounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_viber_accounts_bot ON public.viber_accounts(bot_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.viber_accounts TO authenticated;
GRANT ALL ON public.viber_accounts TO service_role;

ALTER TABLE public.viber_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "viber_accounts by workspace member" ON public.viber_accounts;
CREATE POLICY "viber_accounts by workspace member"
  ON public.viber_accounts
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP TRIGGER IF EXISTS trg_viber_accounts_updated ON public.viber_accounts;
CREATE TRIGGER trg_viber_accounts_updated
  BEFORE UPDATE ON public.viber_accounts
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
