-- WeChat Official Account channel: one row per connected 公众号.
--
-- WeChat differs from the other bot channels in three ways that show up here:
--   * Three secrets, not one: AppSecret (API auth), the webhook Token
--     (signature of inbound calls) and an optional EncodingAESKey (only when
--     the account runs in "safe mode").
--   * Outbound calls need a short-lived access_token fetched from AppID +
--     AppSecret. WeChat rate-limits that endpoint hard, so the token is
--     cached on the row until it expires.
--   * The webhook URL is configured by hand in the WeChat MP console; there
--     is no API to register it, so `status` starts as 'pending_webhook'.

CREATE TABLE IF NOT EXISTS public.wechat_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  account_name text,
  original_id text,
  app_secret_ciphertext text NOT NULL,
  webhook_token_ciphertext text NOT NULL,
  aes_key_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending_webhook',
  status_reason text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_wechat_accounts_workspace ON public.wechat_accounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_wechat_accounts_app ON public.wechat_accounts(app_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wechat_accounts TO authenticated;
GRANT ALL ON public.wechat_accounts TO service_role;

ALTER TABLE public.wechat_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wechat_accounts by workspace member" ON public.wechat_accounts;
CREATE POLICY "wechat_accounts by workspace member"
  ON public.wechat_accounts
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP TRIGGER IF EXISTS trg_wechat_accounts_updated ON public.wechat_accounts;
CREATE TRIGGER trg_wechat_accounts_updated
  BEFORE UPDATE ON public.wechat_accounts
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
