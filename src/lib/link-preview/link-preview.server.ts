/**
 * Cache-or-fetch for link-preview cards. `link_previews` is a global cache
 * (not workspace-scoped — metadata about a public URL isn't tenant data) that
 * only server functions touch, via the service-role client passed in here.
 */
import { sbAny } from "@/lib/supabase/untyped";
import { isAllowedPreviewHost } from "./allowlist";
import { fetchLinkMetadata } from "./fetch-preview.server";

const FRESH_OK_MS = 14 * 24 * 60 * 60 * 1000; // re-check a good preview after 14 days
const RETRY_ERROR_MS = 24 * 60 * 60 * 1000; // retry a failed fetch after 1 day

export type LinkPreviewResult =
  | {
      status: "ok";
      url: string;
      title: string | null;
      description: string | null;
      imageUrl: string | null;
      siteName: string | null;
      faviconUrl: string | null;
    }
  | { status: "blocked"; url: string }
  | { status: "error"; url: string };

type LinkPreviewRow = {
  status: "ok" | "error" | "blocked";
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  favicon_url: string | null;
  fetched_at: string | null;
};

/**
 * Returns a cached preview when fresh, otherwise fetches it (only for an
 * allow-listed host — see `allowlist.ts`) and caches the result, including
 * failures, so a broken or non-allow-listed link is never retried on every
 * render.
 */
export async function getOrFetchLinkPreview(
  db: unknown,
  rawUrl: string,
): Promise<LinkPreviewResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { status: "error", url: rawUrl };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { status: "error", url: rawUrl };
  const url = parsed.toString();

  if (!isAllowedPreviewHost(parsed.hostname)) {
    return { status: "blocked", url };
  }

  const client = sbAny(db);
  const { data: existing } = await client
    .from("link_previews")
    .select("status, title, description, image_url, site_name, favicon_url, fetched_at")
    .eq("url", url)
    .maybeSingle();
  const row = existing as LinkPreviewRow | null;

  if (row?.fetched_at) {
    const age = Date.now() - new Date(row.fetched_at).getTime();
    if (row.status === "ok" && age < FRESH_OK_MS) {
      return {
        status: "ok",
        url,
        title: row.title,
        description: row.description,
        imageUrl: row.image_url,
        siteName: row.site_name,
        faviconUrl: row.favicon_url,
      };
    }
    if (row.status === "error" && age < RETRY_ERROR_MS) {
      return { status: "error", url };
    }
  }

  let meta: Awaited<ReturnType<typeof fetchLinkMetadata>>;
  try {
    meta = await fetchLinkMetadata(url);
  } catch (e) {
    // A cache-write failure here must never surface as the request's own
    // error, so this is wrapped in its own try/catch on top of checking the
    // returned `error` — belt and braces for a write that's already inside
    // the "something went wrong" branch.
    try {
      const { error: cacheErr } = await client
        .from("link_previews")
        .upsert(
          {
            url,
            status: "error",
            error: (e as Error).message.slice(0, 300),
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "url" },
        );
      if (cacheErr) console.warn("[link-preview] cache write failed:", cacheErr.message);
    } catch (cacheThrow) {
      console.warn("[link-preview] cache write threw:", (cacheThrow as Error).message);
    }
    return { status: "error", url };
  }

  // Caching the fetch is best-effort and isolated from the fetch itself —
  // the card still renders from what was just fetched even if the cache
  // write fails (e.g. the migration hasn't been applied yet) or throws; it
  // just won't be cached, so the next request fetches again.
  try {
    const { error: cacheErr } = await client
      .from("link_previews")
      .upsert(
        {
          url,
          status: "ok",
          title: meta.title,
          description: meta.description,
          image_url: meta.imageUrl,
          site_name: meta.siteName,
          favicon_url: meta.faviconUrl,
          error: null,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "url" },
      );
    if (cacheErr) console.warn("[link-preview] cache write failed:", cacheErr.message);
  } catch (cacheThrow) {
    console.warn("[link-preview] cache write threw:", (cacheThrow as Error).message);
  }

  return {
    status: "ok",
    url,
    title: meta.title,
    description: meta.description,
    imageUrl: meta.imageUrl,
    siteName: meta.siteName,
    faviconUrl: meta.faviconUrl,
  };
}
