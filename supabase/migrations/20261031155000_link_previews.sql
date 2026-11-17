-- Rich link-preview cache for chat/inbox messages.
--
-- Metadata about a URL (title, image, site name) is not tenant data, so this
-- cache is global, not workspace-scoped, and shared by every workspace.
-- No PostgREST grants are given to anon/authenticated: every read and write
-- goes through server functions using the service-role client, which is the
-- only place the SSRF-guarded fetcher runs. This keeps the table from ever
-- being a second, unguarded path to populate or read the cache.
CREATE TABLE IF NOT EXISTS public.link_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('ok', 'error', 'blocked')),
  title text,
  description text,
  image_url text,
  site_name text,
  favicon_url text,
  error text,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_previews_fetched_at ON public.link_previews (fetched_at);

GRANT ALL ON public.link_previews TO service_role;
ALTER TABLE public.link_previews ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies for anon/authenticated — service role only.

-- Reuses the project's existing public.set_updated_at() trigger function
-- (defined in migration 20260718174954_...) rather than a per-table copy.
DROP TRIGGER IF EXISTS trg_link_previews_updated_at ON public.link_previews;
CREATE TRIGGER trg_link_previews_updated_at
BEFORE UPDATE ON public.link_previews
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
