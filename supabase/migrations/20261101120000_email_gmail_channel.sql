-- Gmail inbox channel: a 4th `email_accounts.provider` value (OAuth-based,
-- alongside lovable/smtp/resend), plus the incremental-sync cursor it needs.
-- Secrets stay out of client reads, matching api_key_ciphertext/webhook_secret.

alter table public.email_accounts drop constraint if exists email_accounts_provider_chk;
alter table public.email_accounts
  add constraint email_accounts_provider_chk check (provider in ('lovable', 'smtp', 'resend', 'gmail'));

alter table public.email_accounts add column if not exists oauth_refresh_token_ciphertext text;
alter table public.email_accounts add column if not exists gmail_history_id text;
alter table public.email_accounts add column if not exists last_synced_at timestamptz;

-- Re-grant the client-facing column allowlist to include the new, non-secret
-- sync status columns. oauth_refresh_token_ciphertext is deliberately left out.
revoke select on public.email_accounts from authenticated;
revoke select on public.email_accounts from anon;
grant select (
  id, workspace_id, provider, display_name, from_email, from_name, reply_to,
  inbound_address, status, status_reason, metadata, connected_at, connected_by,
  last_verified_at, created_at, updated_at, gmail_history_id, last_synced_at
) on public.email_accounts to authenticated;

-- Poll connected Gmail accounts every 3 minutes through the existing
-- Vault-backed cron helper. True push (Pub/Sub) needs manual Google Cloud
-- Console setup and is a documented future upgrade, not built here.
do $migration$
begin
  if exists (select 1 from pg_proc where proname = '_wa_cron_post')
     and not exists (select 1 from cron.job where jobname = 'wa-gmail-channel-sync') then
    perform cron.schedule(
      'wa-gmail-channel-sync',
      '*/3 * * * *',
      $job$select public._wa_cron_post('/api/public/hooks/gmail-sync');$job$
    );
  end if;
end;
$migration$;

notify pgrst, 'reload schema';
