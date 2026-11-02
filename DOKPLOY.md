# Deploying WACRM on Dokploy (Docker Compose)

Dokploy provides its own reverse proxy (Traefik) + TLS, so this project ships a
Dokploy-ready compose file (`docker-compose.yml`) that does **not** bind host
ports 80/443 and does **not** ship an nginx proxy. Supabase is assumed to be
installed already (external) — point the `SUPABASE_*` env vars at it.

## 1. Push the repo

Fork/clone this repository to a Git host Dokploy can reach (GitHub/GitLab/etc.).

## 2. Create the application in Dokploy

1. Dokploy → **Projects** → select project → **Create Service** → **Compose**.
2. Connect your Git repository and branch.
3. Compose file path: `docker-compose.yml` (default).
4. Click **Deploy**. Dokploy will build the `app` (and `qr-worker`) images.

## 3. Environment variables

In Dokploy → your Compose app → **Environment**, paste the variables from
`.env.example` and fill in real values. Minimum required for the app to boot:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`, `WEBHOOK_SECRET` (generate with `openssl rand -hex 32`)
- `APP_ORIGIN` (your public URL, e.g. `https://app.example.com`)

Optional integrations (WhatsApp Cloud API, Gemini/OpenAI, Meta, Stripe, …) can
be added later; unset ones are flagged in **Setup → Environment** inside the app.

## 4. Domain & TLS

1. Dokploy → your Compose app → **Domains** → add a domain for the `app`
   service on port `3000`. Dokploy issues the TLS certificate.
2. (Optional, only if you use the WhatsApp QR worker) add a domain for the
   `qr-worker` service on port `8787`, or leave it internal-only and set
   `WACRM_WEBHOOK_URL=http://app:3000/api/public/whatsapp/qr-webhook`.

Set `APP_ORIGIN` to the public URL you assigned to `app`.

## 5. WhatsApp QR worker (optional)

The `qr-worker` service needs three shared secrets (same on both sides):

```
openssl rand -hex 32   # WA_QR_WORKER_TOKEN
openssl rand -hex 32   # WA_QR_WORKER_SIGNING_SECRET
openssl rand -hex 32   # WA_QR_WEBHOOK_SECRET
```

Set them in Dokploy Environment. If you do not need WhatsApp QR login, remove
the `qr-worker` block from `docker-compose.yml` before deploying (its auth
volume `wa-auth` persists WhatsApp credentials across restarts — back it up).

## 6. Supabase migrations

Apply the SQL files in `supabase/migrations/` to your already-installed Supabase
instance (Supabase SQL editor or `supabase db push` against your project). The
app will not function without the schema.

## 7. First super admin

Set `SETUP_BOOTSTRAP_TOKEN` in Dokploy Environment, then open
`https://<your-domain>/setup` (or `/install`) and create the first super admin.

## 8. Cron / scheduled jobs (optional)

Scheduled jobs call `/api/public/hooks/*` with `INTERNAL_CRON_TOKEN`. Store the
deployment origin and token in Supabase Vault (SQL editor, as `postgres`):

```sql
select vault.create_secret('https://app.example.com', 'wacrm_cron_base_url');
select vault.create_secret('<INTERNAL_CRON_TOKEN>', 'wacrm_cron_token');
```

## Notes

- The `app` service runs 1 replica by default. Scale via Dokploy or set
  `APP_REPLICAS` (compose `deploy.replicas`).
- Persistent data: only `wa-auth` (WhatsApp credentials). App is stateless;
  all data lives in Supabase.
- Self-hosted (non-Dokploy) production with nginx is preserved in
  `docker-compose.production.yml`.
