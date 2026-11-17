/**
 * Theme engine — server functions and token application helper.
 *
 * Themes ship a `tokens` object of CSS custom properties (e.g. `--primary`).
 * `applyThemeTokens` injects them into `:root` at runtime, so a workspace's
 * active theme + overrides re-skins the app without a rebuild.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { THEME_CONFIG_FIELDS, deriveThemeTokens, pickThemeConfig } from "./theme-config-fields";
import { WhiteLabelSchema } from "@/lib/white-label/white-label.functions";
import { sbAny } from "@/lib/supabase/untyped";

// Reuse the exact per-field validation `upsertWhiteLabel` enforces (URL
// shape, email/enum checks, length caps) — a theme's config ends up written
// straight onto `white_label_configs` on activation, so it needs the same
// guarantees, not a looser one just because it's arriving via a theme.
const ThemeConfigSchema = WhiteLabelSchema.pick(
  Object.fromEntries(THEME_CONFIG_FIELDS.map((f) => [f, true])) as Record<
    (typeof THEME_CONFIG_FIELDS)[number],
    true
  >,
);

function publicClient() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient(process.env.SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: any, init: any) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
          h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

async function activeWorkspaceId(
  supabase: any,
  userId: string,
  requested?: string | null,
): Promise<string> {
  let query = supabase.from("workspace_members").select("workspace_id").eq("user_id", userId);
  if (requested) query = query.eq("workspace_id", requested);
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (requested && !data?.workspace_id) throw new Error("You do not have access to this workspace");
  if (!data?.workspace_id) throw new Error("No workspace for user");
  return data.workspace_id as string;
}

const WorkspaceSchema = z.object({ workspaceId: z.string().uuid().optional().nullable() });

export const listPublicThemes = createServerFn({ method: "GET" }).handler(async () => {
  const client = publicClient();
  const { data, error } = await client
    .from("themes")
    .select("*")
    .eq("is_public", true)
    .order("is_featured", { ascending: false })
    .order("install_count", { ascending: false })
    .limit(60);
  if (error) throw error;
  return { themes: data ?? [] };
});

export const activateTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: { themeId: string; workspaceId?: string | null; overrides?: Record<string, string> }) =>
      z
        .object({
          themeId: z.string().uuid(),
          workspaceId: z.string().uuid().optional().nullable(),
          overrides: z.record(z.string()).optional(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    const { data: isAdmin, error: adminError } = await context.supabase.rpc("is_workspace_admin", {
      _workspace_id: workspaceId,
      _user_id: context.userId,
    });
    if (adminError) throw adminError;
    if (!isAdmin) throw new Error("Only workspace admins can activate themes");
    const { data: publicTheme, error: themeError } = await context.supabase
      .from("themes")
      .select("id")
      .eq("id", data.themeId)
      .eq("is_public", true)
      .maybeSingle();
    if (themeError) throw themeError;
    if (!publicTheme) throw new Error("This theme is unavailable");
    // Clear any theme-scoped overrides left behind by a previously active
    // custom theme, so a marketplace theme's own look always applies clean.
    await clearThemeScopedFields(context.supabase, workspaceId);
    const { error: deactivateError } = await context.supabase
      .from("theme_installations")
      .update({ is_active: false })
      .eq("workspace_id", workspaceId);
    if (deactivateError) throw deactivateError;
    const { error } = await context.supabase.from("theme_installations").upsert(
      {
        workspace_id: workspaceId,
        theme_id: data.themeId,
        overrides: data.overrides ?? {},
        is_active: true,
        installed_by: context.userId,
      },
      { onConflict: "workspace_id,theme_id" },
    );
    if (error) throw error;
    return { ok: true };
  });

export const getActiveTheme = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => WorkspaceSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    const { data: installation, error } = await context.supabase
      .from("theme_installations")
      .select("*, themes(*)")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    // No theme installed — there's no mandatory "Default" row in `themes`
    // (an earlier version of this query assumed an `is_default` column that
    // was never added, which made this call throw for every workspace that
    // hadn't installed anything). Absent an installation, the workspace is
    // just on the bare Tailwind defaults — nothing to fall back to fetch.
    return { installation: installation ?? null, defaultTheme: null, workspaceId };
  });

const ThemeTokensSchema = z
  .record(z.string().max(64), z.string().trim().min(1).max(500))
  .refine((obj) => Object.keys(obj).length > 0, { message: "Theme file has no tokens" })
  .refine((obj) => Object.keys(obj).length <= 200, {
    message: "Theme file has too many tokens (max 200)",
  });

const ImportThemeSchema = z.object({
  workspaceId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(80).default("Custom theme"),
  description: z.string().trim().max(2000).optional().nullable(),
  tokens: ThemeTokensSchema,
});

/**
 * Import a theme file (uploaded by a workspace admin) as a private theme and
 * activate it immediately. Kept separate from the public `themes` marketplace
 * entries (`is_public: false`) so it never appears for other workspaces.
 */
export const importTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => ImportThemeSchema.parse(input))
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    const { data: isAdmin, error: adminError } = await context.supabase.rpc("is_workspace_admin", {
      _workspace_id: workspaceId,
      _user_id: context.userId,
    });
    if (adminError) throw adminError;
    if (!isAdmin) throw new Error("Only workspace admins can import themes");

    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.tokens)) {
      tokens[key.startsWith("--") ? key : `--${key}`] = value;
    }

    const slug = `custom-${workspaceId.slice(0, 8)}-${Date.now().toString(36)}`;
    const { data: theme, error: insertError } = await context.supabase
      .from("themes")
      .insert({
        slug,
        name: data.name,
        description: data.description ?? null,
        tokens,
        publisher_id: context.userId,
        is_public: false,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const { error: deactivateError } = await context.supabase
      .from("theme_installations")
      .update({ is_active: false })
      .eq("workspace_id", workspaceId);
    if (deactivateError) throw deactivateError;

    const { error: installError } = await context.supabase.from("theme_installations").upsert(
      {
        workspace_id: workspaceId,
        theme_id: theme.id,
        overrides: {},
        is_active: true,
        installed_by: context.userId,
      },
      { onConflict: "workspace_id,theme_id" },
    );
    if (installError) throw installError;

    return { ok: true, themeId: theme.id as string };
  });

/**
 * List the workspace's own private themes (never the marketplace) — the
 * "My themes" switcher in the Theme Manager. Each row carries its full
 * `config`, since the editor binds directly to whichever one is selected.
 */
export const listMyThemes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => WorkspaceSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    // `config` is a new column not yet in the generated Database types.
    const { data: themes, error } = await sbAny(context.supabase)
      .from("themes")
      .select("id, name, description, config, created_at")
      .eq("is_public", false)
      .eq("publisher_id", context.userId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const { data: installation, error: instError } = await context.supabase
      .from("theme_installations")
      .select("theme_id")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .maybeSingle();
    if (instError) throw instError;
    return { themes: themes ?? [], activeThemeId: installation?.theme_id ?? null, workspaceId };
  });

const SaveMyThemeSchema = z.object({
  themeId: z.string().uuid().optional().nullable(),
  workspaceId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).optional().nullable(),
  config: ThemeConfigSchema,
});

async function assertWorkspaceAdmin(
  supabase: any,
  workspaceId: string,
  userId: string,
  action: string,
) {
  const { data: isAdmin, error } = await supabase.rpc("is_workspace_admin", {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (error) throw error;
  if (!isAdmin) throw new Error(`Only workspace admins can ${action}`);
}

/**
 * Create a new private theme, or overwrite one you already created — the
 * single save path for the Theme Manager editor. Saving never activates it;
 * that's a separate, explicit action so switching between several draft
 * themes never silently changes what's live.
 */
export const saveMyTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => SaveMyThemeSchema.parse(input))
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    await assertWorkspaceAdmin(context.supabase, workspaceId, context.userId, "save themes");

    // Already validated and stripped to the known fields by ThemeConfigSchema.
    const config = data.config;
    const tokens = deriveThemeTokens(config);

    if (data.themeId) {
      const { data: existing, error: existingError } = await context.supabase
        .from("themes")
        .select("id, is_public, publisher_id")
        .eq("id", data.themeId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) throw new Error("Theme not found");
      if (existing.is_public)
        throw new Error(
          "Public marketplace themes can't be edited here — create your own theme instead",
        );
      if (existing.publisher_id !== context.userId)
        throw new Error("You can only update themes you created");
      const { error } = await sbAny(context.supabase)
        .from("themes")
        .update({ name: data.name, description: data.description ?? null, config, tokens })
        .eq("id", data.themeId);
      if (error) throw error;
      return { themeId: data.themeId };
    }

    const slug = `custom-${workspaceId.slice(0, 8)}-${Date.now().toString(36)}`;
    const { data: created, error: insertError } = await sbAny(context.supabase)
      .from("themes")
      .insert({
        slug,
        name: data.name,
        description: data.description ?? null,
        config,
        tokens,
        publisher_id: context.userId,
        is_public: false,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    return { themeId: created.id as string };
  });

/** Write every theme-scoped field to `null` on the workspace's white-label
 * row — the shared "clear the slate" step both activation paths run before
 * applying a theme's own config, so switching themes is always a full swap
 * rather than old colors bleeding through from whatever was active before. */
async function clearThemeScopedFields(supabase: any, workspaceId: string) {
  const blank = Object.fromEntries(THEME_CONFIG_FIELDS.map((f) => [f, null]));
  const { error } = await supabase
    .from("white_label_configs")
    .upsert({ workspace_id: workspaceId, ...blank }, { onConflict: "workspace_id" });
  if (error) throw error;
}

const ActivateMyThemeSchema = z.object({
  themeId: z.string().uuid(),
  workspaceId: z.string().uuid().optional().nullable(),
});

/**
 * Activate one of the workspace's own private themes: copies its full config
 * onto the live white-label row (so the whole look — colors, type, layout,
 * logos, login page, email — applies together) and marks it active in
 * `theme_installations` so the Theme Manager can highlight it.
 */
export const activateMyTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => ActivateMyThemeSchema.parse(input))
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    await assertWorkspaceAdmin(context.supabase, workspaceId, context.userId, "activate themes");

    const { data: theme, error: themeError } = await sbAny(context.supabase)
      .from("themes")
      .select("id, is_public, publisher_id, config")
      .eq("id", data.themeId)
      .maybeSingle();
    if (themeError) throw themeError;
    if (!theme) throw new Error("Theme not found");
    if (theme.is_public || theme.publisher_id !== context.userId)
      throw new Error("You can only activate themes you created");

    await clearThemeScopedFields(context.supabase, workspaceId);
    const config = pickThemeConfig(theme.config as Record<string, unknown>);
    const { error: writeError } = await sbAny(context.supabase)
      .from("white_label_configs")
      .upsert(
        { workspace_id: workspaceId, ...config, is_active: true },
        { onConflict: "workspace_id" },
      );
    if (writeError) throw writeError;

    const { error: deactivateError } = await context.supabase
      .from("theme_installations")
      .update({ is_active: false })
      .eq("workspace_id", workspaceId);
    if (deactivateError) throw deactivateError;
    const { error: installError } = await context.supabase.from("theme_installations").upsert(
      {
        workspace_id: workspaceId,
        theme_id: data.themeId,
        overrides: {},
        is_active: true,
        installed_by: context.userId,
      },
      { onConflict: "workspace_id,theme_id" },
    );
    if (installError) throw installError;
    return { ok: true };
  });

const DeleteMyThemeSchema = z.object({
  themeId: z.string().uuid(),
  workspaceId: z.string().uuid().optional().nullable(),
});

export const deleteMyTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => DeleteMyThemeSchema.parse(input))
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    await assertWorkspaceAdmin(context.supabase, workspaceId, context.userId, "delete themes");
    const { data: theme, error: themeError } = await context.supabase
      .from("themes")
      .select("id, is_public, publisher_id")
      .eq("id", data.themeId)
      .maybeSingle();
    if (themeError) throw themeError;
    if (!theme) return { ok: true };
    if (theme.is_public || theme.publisher_id !== context.userId)
      throw new Error("You can only delete themes you created");
    const { data: installation } = await context.supabase
      .from("theme_installations")
      .select("is_active")
      .eq("workspace_id", workspaceId)
      .eq("theme_id", data.themeId)
      .maybeSingle();
    if (installation?.is_active)
      throw new Error("Activate a different theme before deleting this one");
    const { error } = await context.supabase.from("themes").delete().eq("id", data.themeId);
    if (error) throw error;
    return { ok: true };
  });

/**
 * Reset the workspace back to the default look: no theme active, and every
 * theme-scoped white-label field cleared so nothing bleeds through from
 * whatever was active before. Accent + appearance mode are reset by their
 * own owners on the client; the domain stays untouched.
 */
export const resetWorkspaceTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => WorkspaceSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const workspaceId = await activeWorkspaceId(context.supabase, context.userId, data.workspaceId);
    await assertWorkspaceAdmin(context.supabase, workspaceId, context.userId, "reset themes");
    const { error } = await context.supabase
      .from("theme_installations")
      .update({ is_active: false })
      .eq("workspace_id", workspaceId);
    if (error) throw error;
    await clearThemeScopedFields(context.supabase, workspaceId);
    await context.supabase
      .from("white_label_configs")
      .update({ is_active: false })
      .eq("workspace_id", workspaceId);
    return { ok: true };
  });
