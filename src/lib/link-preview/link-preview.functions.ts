/**
 * Inbox-side (authenticated) entry point for link-preview cards.
 *
 * `link_previews` grants nothing to `authenticated` (service role only — see
 * the migration), so this goes through `supabaseAdmin`, not the caller's own
 * RLS-scoped client.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/lib/demo/admin-write-guard.server";
import { getOrFetchLinkPreview, type LinkPreviewResult } from "./link-preview.server";

export const getLinkPreview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => z.object({ url: z.string().min(1).max(2000) }).parse(v))
  .handler(async ({ data }): Promise<LinkPreviewResult> => {
    return getOrFetchLinkPreview(supabaseAdmin, data.url);
  });
