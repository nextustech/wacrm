/**
 * Fetches OpenGraph / basic HTML metadata for a link-preview card.
 *
 * Only called for a URL that has already passed `isAllowedPreviewHost()` —
 * see `allowlist.ts` for why a domain allowlist, not IP filtering, is this
 * feature's actual SSRF defense on this deployment target. This module adds
 * the usual fetch-time guards (timeout, size cap, bounded redirects,
 * re-validating every redirect target against the same allowlist) as
 * defense-in-depth, not as the primary control.
 */
import { isAllowedPreviewHost, isLiteralPrivateIp } from "./allowlist";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 1_500_000; // metadata lives in <head>; 1.5 MB is generous
const MAX_REDIRECTS = 3;

export interface LinkMetadata {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  finalUrl: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function validateCandidate(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) URLs are supported");
  if (isLiteralPrivateIp(parsed.hostname)) throw new Error("Blocked host");
  if (!isAllowedPreviewHost(parsed.hostname)) throw new Error("Host not allow-listed");
  return parsed;
}

/** Reads up to `MAX_BYTES` of the response body as text, aborting the rest. */
async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        chunks.push(value.subarray(0, Math.max(0, MAX_BYTES - (total - value.byteLength))));
        void reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8").decode(buf);
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const v = decodeEntities(m[1]).trim();
      if (v) return v;
    }
  }
  return null;
}

function resolveUrl(maybeRelative: string, base: URL): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

/**
 * Fetches and parses OG/basic metadata for an allow-listed URL. Follows up to
 * `MAX_REDIRECTS` redirects, re-validating the target host at every hop so a
 * redirect can't be used to reach a non-allow-listed host.
 */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  let target = validateCandidate(url);
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(target.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "WACRMLinkPreview/1.0 (+https://wacrm.app)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect with no Location header");
      target = validateCandidate(resolveUrl(location, target) ?? location);
      continue;
    }
    break;
  }

  if (!res) throw new Error("No response");
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

  const ct = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    throw new Error(`Unsupported content-type: ${ct || "unknown"}`);
  }

  const html = await readBounded(res);
  const finalUrl = res.url || target.toString();
  const base = new URL(finalUrl);

  const title =
    metaContent(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i,
    ]) ?? metaContent(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);

  const description = metaContent(html, [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
  ]);

  const rawImage = metaContent(html, [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
  ]);
  const imageUrl = rawImage ? resolveUrl(rawImage, base) : null;
  // The image host also has to be allow-listed — og:image can point anywhere
  // (a CDN on a different domain), and this is what the browser actually
  // loads from the rendered card.
  const safeImageUrl = imageUrl && isAllowedPreviewHost(new URL(imageUrl).hostname) ? imageUrl : null;

  const siteName = metaContent(html, [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:site_name["']/i,
  ]);

  const rawIcon = metaContent(html, [
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)["']/i,
    /<link[^>]+href=["']([^"']*)["'][^>]+rel=["'](?:shortcut )?icon["']/i,
  ]);
  const faviconCandidate = rawIcon ? resolveUrl(rawIcon, base) : resolveUrl("/favicon.ico", base);
  const faviconUrl =
    faviconCandidate && isAllowedPreviewHost(new URL(faviconCandidate).hostname)
      ? faviconCandidate
      : null;

  return { title, description, imageUrl: safeImageUrl, siteName, faviconUrl, finalUrl };
}
