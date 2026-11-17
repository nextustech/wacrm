/**
 * Curated Google Fonts catalog + loader for workspace typography.
 * A curated list (rather than the full ~1800-font catalog) keeps weight data
 * accurate and the picker fast, while covering the fonts teams actually pick.
 */

export type FontCategory = "sans-serif" | "serif" | "monospace" | "display" | "handwriting";

export type GoogleFont = {
  family: string;
  category: FontCategory;
  /** Static weights published for this family on Google Fonts. */
  weights: number[];
};

export const FONT_WEIGHT_LABELS: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
};

export const FONT_SIZE_PRESETS: { label: string; value: string }[] = [
  { label: "Compact", value: "14px" },
  { label: "Default", value: "16px" },
  { label: "Comfortable", value: "18px" },
  { label: "Large", value: "20px" },
];

const FALLBACK_STACK: Record<FontCategory, string> = {
  "sans-serif": "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  monospace: "ui-monospace, SFMono-Regular, monospace",
  display: "ui-sans-serif, system-ui, sans-serif",
  handwriting: "cursive",
};

export const GOOGLE_FONTS: GoogleFont[] = [
  // Sans-serif
  { family: "Inter", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Roboto", category: "sans-serif", weights: [100, 300, 400, 500, 700, 900] },
  { family: "Open Sans", category: "sans-serif", weights: [300, 400, 500, 600, 700, 800] },
  { family: "Lato", category: "sans-serif", weights: [100, 300, 400, 700, 900] },
  { family: "Montserrat", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Poppins", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Nunito", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Nunito Sans", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Work Sans", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Mulish", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Rubik", category: "sans-serif", weights: [300, 400, 500, 600, 700, 800, 900] },
  { family: "Manrope", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800] },
  { family: "DM Sans", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Plus Jakarta Sans", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800] },
  { family: "Outfit", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Sora", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800] },
  { family: "Figtree", category: "sans-serif", weights: [300, 400, 500, 600, 700, 800, 900] },
  { family: "Urbanist", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Karla", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800] },
  { family: "Space Grotesk", category: "sans-serif", weights: [300, 400, 500, 600, 700] },
  { family: "IBM Plex Sans", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700] },
  { family: "Source Sans 3", category: "sans-serif", weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "PT Sans", category: "sans-serif", weights: [400, 700] },
  { family: "Noto Sans", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Barlow", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Hind", category: "sans-serif", weights: [300, 400, 500, 600, 700] },
  { family: "Lexend", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Albert Sans", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Be Vietnam Pro", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Hanken Grotesk", category: "sans-serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },

  // Serif
  { family: "Merriweather", category: "serif", weights: [300, 400, 700, 900] },
  { family: "Playfair Display", category: "serif", weights: [400, 500, 600, 700, 800, 900] },
  { family: "Lora", category: "serif", weights: [400, 500, 600, 700] },
  { family: "PT Serif", category: "serif", weights: [400, 700] },
  { family: "Source Serif 4", category: "serif", weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Noto Serif", category: "serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Crimson Text", category: "serif", weights: [400, 600, 700] },
  { family: "Libre Baskerville", category: "serif", weights: [400, 700] },
  { family: "EB Garamond", category: "serif", weights: [400, 500, 600, 700, 800] },
  { family: "Cormorant Garamond", category: "serif", weights: [300, 400, 500, 600, 700] },
  { family: "Bitter", category: "serif", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "Spectral", category: "serif", weights: [200, 300, 400, 500, 600, 700, 800] },

  // Monospace
  { family: "JetBrains Mono", category: "monospace", weights: [100, 200, 300, 400, 500, 600, 700, 800] },
  { family: "Fira Code", category: "monospace", weights: [300, 400, 500, 600, 700] },
  { family: "Roboto Mono", category: "monospace", weights: [100, 200, 300, 400, 500, 600, 700] },
  { family: "Source Code Pro", category: "monospace", weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "IBM Plex Mono", category: "monospace", weights: [100, 200, 300, 400, 500, 600, 700] },
  { family: "Space Mono", category: "monospace", weights: [400, 700] },
  { family: "Inconsolata", category: "monospace", weights: [200, 300, 400, 500, 600, 700, 800, 900] },
  { family: "DM Mono", category: "monospace", weights: [300, 400, 500] },
  { family: "Red Hat Mono", category: "monospace", weights: [300, 400, 500, 600, 700] },
  { family: "Ubuntu Mono", category: "monospace", weights: [400, 700] },

  // Display / handwriting
  { family: "Bebas Neue", category: "display", weights: [400] },
  { family: "Oswald", category: "display", weights: [200, 300, 400, 500, 600, 700] },
  { family: "Anton", category: "display", weights: [400] },
  { family: "Archivo Black", category: "display", weights: [400] },
  { family: "Righteous", category: "display", weights: [400] },
  { family: "Abril Fatface", category: "display", weights: [400] },
  { family: "Fredoka", category: "display", weights: [300, 400, 500, 600, 700] },
  { family: "Baloo 2", category: "display", weights: [400, 500, 600, 700, 800] },
  { family: "Lobster", category: "handwriting", weights: [400] },
  { family: "Pacifico", category: "handwriting", weights: [400] },
  { family: "Caveat", category: "handwriting", weights: [400, 500, 600, 700] },
];

export function findGoogleFont(family: string | null | undefined): GoogleFont | undefined {
  if (!family) return undefined;
  const trimmed = family.trim().toLowerCase();
  return GOOGLE_FONTS.find((f) => f.family.toLowerCase() === trimmed);
}

/**
 * Resolves the CSS `font-family` value for a saved family string.
 * A value containing a comma is treated as an already-complete stack
 * (legacy/custom entries saved before the picker existed) and passed through
 * unchanged; a bare family name is matched against the catalog and given a
 * fallback stack suited to its category.
 */
export function fontFamilyValue(family: string | null | undefined): string {
  if (!family) return "";
  const trimmed = family.trim();
  if (!trimmed) return "";
  if (trimmed.includes(",")) return trimmed;
  const font = findGoogleFont(trimmed);
  const fallback = font ? FALLBACK_STACK[font.category] : "sans-serif";
  const quoted = /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
  return `${quoted}, ${fallback}`;
}

function googleFontsHref(entries: Array<{ family: string; weights?: number[] }>): string | null {
  const byFamily = new Map<string, number[] | undefined>();
  for (const { family, weights } of entries) {
    const font = findGoogleFont(family);
    if (!font) continue;
    const existing = byFamily.get(font.family);
    if (!weights?.length || existing === undefined) {
      byFamily.set(font.family, undefined);
    } else {
      const merged = Array.from(new Set([...existing, ...weights]));
      byFamily.set(font.family, merged);
    }
  }

  const families = Array.from(byFamily.entries())
    .map(([familyName, weights]) => {
      const font = findGoogleFont(familyName);
      if (!font) return null;
      const chosen = (weights?.length ? weights : font.weights).filter((w) => font.weights.includes(w));
      const list = (chosen.length ? chosen : font.weights).slice().sort((a, b) => a - b).join(";");
      return `family=${encodeURIComponent(font.family).replace(/%20/g, "+")}:wght@${list}`;
    })
    .filter((v): v is string => Boolean(v));
  if (!families.length) return null;
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}

/** Loads (or updates) a `<link>` stylesheet for the given Google Font families/weights under a stable id. */
export function loadGoogleFontLink(id: string, entries: Array<{ family: string; weights?: number[] }>) {
  if (typeof document === "undefined") return;
  const href = googleFontsHref(entries);
  if (!href) {
    document.getElementById(id)?.remove();
    return;
  }
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

export function removeGoogleFontLink(id: string) {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.remove();
}

const WORKSPACE_FONTS_LINK_ID = "wacrm-google-fonts";

/** Loads the active workspace's Google Fonts (sans/heading/mono) for the whole app. */
export function loadGoogleFonts(entries: Array<{ family: string; weights?: number[] }>) {
  loadGoogleFontLink(WORKSPACE_FONTS_LINK_ID, entries);
}

export function unloadGoogleFonts() {
  removeGoogleFontLink(WORKSPACE_FONTS_LINK_ID);
}
