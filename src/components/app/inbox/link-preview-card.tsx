/**
 * WhatsApp/Messenger-style rich link card — a thumbnail + title + site name
 * below a message bubble, clickable through to the real URL. Shared by the
 * Inbox conversation view and the public chat widget; only the `fetcher`
 * differs (an authenticated server fn for the Inbox, a signed public POST
 * for the widget — see `link-preview.functions.ts` and
 * `api/public/widget/link-preview.ts`).
 *
 * Renders nothing when there's no link, the fetch is still loading with
 * nothing to show yet past a brief delay, or the link has no previewable
 * metadata (non-allow-listed host, fetch failed, or the page had neither a
 * title nor an image) — the message's own clickable link (via
 * `FormattedText`) is the fallback in every one of those cases, so a missing
 * card never hides functionality.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export type LinkPreviewData =
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

export type LinkPreviewFetcher = (url: string) => Promise<LinkPreviewData>;

// Per-page-load cache so scrolling a conversation never re-fetches the same
// link twice, and two bubbles sharing a link share one request.
const cache = new Map<string, Promise<LinkPreviewData>>();

function load(url: string, fetcher: LinkPreviewFetcher): Promise<LinkPreviewData> {
  const cached = cache.get(url);
  if (cached) return cached;
  const promise = fetcher(url).catch((): LinkPreviewData => ({ status: "error", url }));
  cache.set(url, promise);
  return promise;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function LinkPreviewCard({
  url,
  fetcher,
  className,
}: {
  url: string | null;
  fetcher: LinkPreviewFetcher;
  className?: string;
}) {
  const [data, setData] = useState<LinkPreviewData | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);

  useEffect(() => {
    setData(null);
    if (!url) return;
    let cancelled = false;
    // Only show a loading placeholder if the fetch (first time, uncached)
    // takes a moment — a cache hit should never flash a skeleton.
    const skeletonTimer = setTimeout(() => {
      if (!cancelled) setShowSkeleton(true);
    }, 150);
    load(url, fetcher).then((result) => {
      if (cancelled) return;
      clearTimeout(skeletonTimer);
      setShowSkeleton(false);
      setData(result);
    });
    return () => {
      cancelled = true;
      clearTimeout(skeletonTimer);
    };
  }, [url, fetcher]);

  if (!url) return null;

  if (!data) {
    return showSkeleton ? (
      <Skeleton className={cn("mt-1.5 h-16 w-full max-w-[280px]", className)} />
    ) : null;
  }

  if (data.status !== "ok" || (!data.imageUrl && !data.title)) return null;

  return (
    <a
      href={data.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "mt-1.5 flex max-w-[280px] overflow-hidden rounded-control border border-current/15 bg-background/70 text-left no-underline transition hover:border-current/30",
        className,
      )}
    >
      {data.imageUrl && (
        <img
          src={data.imageUrl}
          alt=""
          className="h-16 w-16 shrink-0 object-cover"
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
      <div className="min-w-0 flex-1 px-2.5 py-1.5">
        <div className="truncate text-[10px] uppercase tracking-wide opacity-60 text-foreground ">
          {data.siteName || hostnameOf(data.url)}
        </div>
        {data.title && (
          <div className="line-clamp-2 text-xs font-medium leading-snug text-foreground">
            {data.title}
          </div>
        )}
      </div>
    </a>
  );
}
