import { fontFamilyValue } from "@/lib/fonts/google-fonts";

/**
 * The white-label fields that make up a *theme's* look — saved per-theme,
 * swapped wholesale on activation, and shared between the server (building
 * the row to insert/update, deriving CSS tokens) and the client (building
 * the editor form, picking which section a field belongs to).
 *
 * Deliberately excluded (stay on the workspace, never swapped by a theme):
 *   - custom_domain, custom_domain_verified — DNS-level, switching a theme
 *     must never touch a verified domain.
 *   - is_active, workspace_id, id, created_at, updated_at — bookkeeping.
 *   - custom_css, custom_js, remove_lovable_branding — advanced/unlisted
 *     escape hatches, not part of the themeable surface today.
 */
export const THEME_CONFIG_FIELDS = [
  "brand_name",
  "logo_url",
  "logo_dark_url",
  "favicon_url",
  "support_email",
  "support_url",
  "meta_title",
  "meta_description",
  "social_x",
  "social_instagram",
  "social_facebook",
  "social_tiktok",
  "social_threads",
  "social_youtube",
  "social_linkedin",
  "social_website",
  "primary_color",
  "secondary_color",
  "accent_color",
  "background_color",
  "foreground_color",
  "border_color",
  "sidebar_background",
  "sidebar_foreground",
  "sidebar_accent",
  "sidebar_border",
  "dashboard_background",
  "dashboard_accent",
  "font_family_sans",
  "font_family_heading",
  "font_family_mono",
  "font_size_base",
  "font_weight_sans",
  "font_weight_heading",
  "font_weight_mono",
  "icon_style",
  "icon_stroke_width",
  "border_radius",
  "default_color_mode",
  "dark_primary_color",
  "dark_background_color",
  "dark_accent_color",
  "login_background_url",
  "login_headline",
  "login_subheadline",
  "login_layout",
  "loader_url",
  "loader_style",
  "email_logo_url",
  "email_from_name",
  "email_primary_color",
  "email_header_color",
  "custom_email_footer",
] as const;

export type ThemeConfigField = (typeof THEME_CONFIG_FIELDS)[number];
export type ThemeConfig = Partial<Record<ThemeConfigField, string | number | null>>;

/** Keep only the recognized theme fields from an arbitrary object. */
export function pickThemeConfig(input: Record<string, unknown> | null | undefined): ThemeConfig {
  const out: ThemeConfig = {};
  if (!input) return out;
  for (const field of THEME_CONFIG_FIELDS) {
    if (input[field] !== undefined) out[field] = input[field] as string | number | null;
  }
  return out;
}

const FONT_WEIGHT_FIELDS: Record<string, string> = {
  font_weight_sans: "--font-weight-sans",
  font_weight_heading: "--font-weight-heading",
  font_weight_mono: "--font-weight-mono",
};

/**
 * Derive the exportable/installable CSS token dict from a theme config —
 * mirrors the field → CSS var mapping ThemeApplier.tsx uses at render time,
 * so a theme's `tokens` (used for preview swatches and export) always
 * matches what activating it will actually look like.
 */
export function deriveThemeTokens(config: ThemeConfig): Record<string, string> {
  const tokens: Record<string, string> = {};
  const colorFields: [ThemeConfigField, string][] = [
    ["primary_color", "--primary"],
    ["secondary_color", "--secondary"],
    ["accent_color", "--accent"],
    ["background_color", "--background"],
    ["foreground_color", "--foreground"],
    ["border_color", "--border"],
    ["sidebar_background", "--sidebar"],
    ["sidebar_foreground", "--sidebar-foreground"],
    ["sidebar_accent", "--sidebar-accent"],
    ["sidebar_border", "--sidebar-border"],
    ["dashboard_background", "--dashboard-background"],
    ["dashboard_accent", "--dashboard-accent"],
    ["border_radius", "--radius"],
  ];
  for (const [field, cssVar] of colorFields) {
    const value = config[field];
    if (typeof value === "string" && value) tokens[cssVar] = value;
  }
  if (config.icon_stroke_width != null) tokens["--icon-stroke"] = String(config.icon_stroke_width);
  for (const [field, cssVar] of Object.entries(FONT_WEIGHT_FIELDS)) {
    const value = config[field as ThemeConfigField];
    if (typeof value === "string" && value) tokens[cssVar] = value;
  }
  if (typeof config.font_family_sans === "string" && config.font_family_sans) {
    tokens["--font-sans"] = fontFamilyValue(config.font_family_sans);
  }
  if (typeof config.font_family_heading === "string" && config.font_family_heading) {
    tokens["--font-heading"] = fontFamilyValue(config.font_family_heading);
  }
  if (typeof config.font_family_mono === "string" && config.font_family_mono) {
    tokens["--font-mono"] = fontFamilyValue(config.font_family_mono);
  }
  if (typeof config.font_size_base === "string" && config.font_size_base) {
    tokens["--font-size-base"] = config.font_size_base;
  }
  return tokens;
}
