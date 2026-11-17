/**
 * Domain allowlist and basic SSRF guards for the link-preview fetcher.
 *
 * The chatbot only ever links to a handful of known marketplace/company
 * domains (confirmed by scanning every published KB article), so a strict
 * allowlist is both the simplest and the strongest guarantee here — far
 * stronger than trying to filter arbitrary hosts by resolved IP. That
 * matters because the real deployment target is Cloudflare Workers
 * (`npm run build` → `scripts/build-cloudflare.mjs`), where `node:dns`
 * resolution isn't available to pre-validate a hostname's IP before
 * fetching, the way a plain Node server could. A link that isn't
 * allow-listed never gets a thumbnail card; the message still renders as a
 * normal clickable link (see `rich-text.ts` / `FormattedText`), so nothing
 * breaks — a preview is just additive.
 *
 * Add a domain here (and its real subdomains, e.g. the eventual demo
 * hostname for a new product) only when it's a destination this app is
 * actually meant to link to.
 */
export const ALLOWED_PREVIEW_HOSTS: readonly string[] = [
  "codecanyon.net",
  "envato.com",
  "themeforest.net",
  "wrapmarket.com",
  "wrapcoders.com",
  // Envato serves marketplace thumbnails and favicons from this separate CDN
  // domain, not from codecanyon.net/envato.com themselves — confirmed by
  // fetching a real CodeCanyon portfolio page. Without this, every CodeCanyon
  // preview card would have no image.
  "envato-static.com",
];

/** True when `hostname` is an allow-listed domain or a subdomain of one. */
export function isAllowedPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_PREVIEW_HOSTS.some((root) => host === root || host.endsWith(`.${root}`));
}

/**
 * Cheap, DNS-free guard against the common literal-IP SSRF targets (loopback,
 * link-local / cloud metadata, private ranges). This is defense-in-depth for
 * if the allowlist above is ever loosened to a non-literal, wider pattern —
 * it does not by itself make fetching an arbitrary hostname safe, since a
 * hostname can still resolve to a private IP at fetch time (DNS rebinding).
 */
export function isLiteralPrivateIp(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;

  // IPv4 literal.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true; // "this network"
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast + reserved (224-255)
    return false;
  }

  // IPv6 literal (with or without brackets).
  const v6 = h.replace(/^\[|\]$/g, "");
  if (v6.includes(":")) {
    if (v6 === "::1" || v6 === "::") return true;
    if (/^fe[89ab][0-9a-f]:/i.test(v6)) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // unique local fc00::/7
    if (/^::ffff:/i.test(v6)) {
      // IPv4-mapped IPv6 — re-check the embedded IPv4 address.
      const mapped = v6.split(":").pop() ?? "";
      if (mapped.includes(".")) return isLiteralPrivateIp(mapped);
    }
    return false;
  }

  return false;
}
