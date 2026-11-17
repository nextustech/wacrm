/**
 * Viber bot account management — connect, list, verify, disconnect.
 *
 * The workspace pastes the auth token from the Viber Admin Panel; we call
 * `get_account_info` to validate it, register the per-account webhook, and
 * persist the token encrypted at rest. Unlike Telegram there is no separate
 * webhook secret: Viber signs each delivery with the same auth token, which
 * the webhook handler verifies.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface ViberAccountSummary {
  id: string;
  bot_id: string;
  bot_name: string | null;
  bot_uri: string | null;
  bot_icon_url: string | null;
  status: string;
  status_reason: string | null;
  connected_at: string;
  last_verified_at: string | null;
}

/** Viber tokens are dash-separated hex groups, e.g. `4e6f1a2b…-a1b2…-c3d4…`. */
const TOKEN_RE = /^[0-9a-f]{8,}(-[0-9a-f]{8,}){1,3}$/i;

const ACCOUNT_COLUMNS =
  "id, bot_id, bot_name, bot_uri, bot_icon_url, status, status_reason, connected_at, last_verified_at";

export const listViberAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { workspaceId: string }) =>
    z.object({ workspaceId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("viber_accounts" as never)
      .select(ACCOUNT_COLUMNS)
      .eq("workspace_id", data.workspaceId)
      .order("connected_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { accounts: (rows ?? []) as unknown as ViberAccountSummary[] };
  });

export const connectViberBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { workspaceId: string; authToken: string; origin: string }) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        authToken: z.string().trim().min(20).max(200),
        origin: z.string().url(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const authToken = data.authToken.trim();
    if (!TOKEN_RE.test(authToken)) {
      throw new Error(
        "That does not look like a Viber bot token (expected dash-separated hex from the Viber Admin Panel).",
      );
    }

    const { getViberAccountInfo, setViberWebhook } = await import("./send.server");
    const info = await getViberAccountInfo(authToken);
    const botId = String(info.id ?? "").trim();
    if (!botId) throw new Error("Viber accepted the token but returned no bot id.");

    const { encryptToken } = await import("@/lib/instagram/token-crypto.server");
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");

    const { data: existingRaw } = await supabaseAdmin
      .from("viber_accounts" as never)
      .select("id")
      .eq("workspace_id", data.workspaceId)
      .eq("bot_id", botId)
      .maybeSingle();
    const alreadyConnected = !!existingRaw;

    const { data: saved, error } = await supabaseAdmin
      .from("viber_accounts" as never)
      .upsert(
        {
          workspace_id: data.workspaceId,
          bot_id: botId,
          bot_name: info.name ?? null,
          bot_uri: info.uri ?? null,
          bot_icon_url: info.icon ?? null,
          auth_token_ciphertext: encryptToken(authToken),
          status: "connected",
          status_reason: null,
          connected_by: context.userId,
          last_verified_at: new Date().toISOString(),
        } as never,
        { onConflict: "workspace_id,bot_id" },
      )
      .select(ACCOUNT_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const account = saved as unknown as ViberAccountSummary | null;
    if (!account) throw new Error("Could not save the Viber bot");

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "viber_account.connect",
      severity: "info",
      workspaceId: data.workspaceId,
      actorId: context.userId,
      resourceType: "viber_account",
      resourceId: account.id,
      data: { bot_id: botId, bot_uri: info.uri ?? null },
    });

    const webhookUrl = `${data.origin.replace(/\/$/, "")}/api/public/webhooks/viber/${account.id}`;
    try {
      await setViberWebhook(authToken, webhookUrl);
    } catch (err) {
      await supabaseAdmin
        .from("viber_accounts" as never)
        .update({
          status: "webhook_not_set",
          status_reason: (err as Error).message.slice(0, 500),
        } as never)
        .eq("id", account.id);
      throw new Error(`Bot verified, but webhook registration failed: ${(err as Error).message}`);
    }

    return { account, webhookUrl, alreadyConnected, botName: info.name ?? null };
  });

export const verifyViberAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { accountId: string; origin: string }) =>
    z.object({ accountId: z.string().uuid(), origin: z.string().url() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rowRaw, error } = await context.supabase
      .from("viber_accounts" as never)
      .select("id, workspace_id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!rowRaw) throw new Error("Viber bot not found");

    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data: secretRaw } = await supabaseAdmin
      .from("viber_accounts" as never)
      .select("auth_token_ciphertext")
      .eq("id", data.accountId)
      .maybeSingle();
    const cipher = (secretRaw as unknown as { auth_token_ciphertext: string } | null)
      ?.auth_token_ciphertext;
    if (!cipher) throw new Error("Stored auth token missing — reconnect the bot");

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "secrets.view",
      severity: "warning",
      workspaceId: (rowRaw as unknown as { workspace_id: string }).workspace_id,
      actorId: context.userId,
      resourceType: "viber_account",
      resourceId: data.accountId,
    });

    const { decryptToken } = await import("@/lib/instagram/token-crypto.server");
    const { getViberAccountInfo, setViberWebhook, ViberApiError } = await import("./send.server");
    const expected = `${data.origin.replace(/\/$/, "")}/api/public/webhooks/viber/${data.accountId}`;

    try {
      const token = decryptToken(cipher);
      const info = await getViberAccountInfo(token);
      // `get_account_info` reports the registered URL, so webhook drift is
      // visible here — re-register rather than only reporting it.
      let webhook = info.webhook ?? null;
      if (webhook !== expected) {
        await setViberWebhook(token, expected);
        webhook = expected;
      }
      await supabaseAdmin
        .from("viber_accounts" as never)
        .update({
          bot_name: info.name ?? null,
          bot_uri: info.uri ?? null,
          bot_icon_url: info.icon ?? null,
          status: "connected",
          status_reason: null,
          last_verified_at: new Date().toISOString(),
        } as never)
        .eq("id", data.accountId);
      return { ok: true, status: "connected", webhookUrl: webhook, expectedUrl: expected };
    } catch (err) {
      const msg = (err as Error).message;
      const authFailed = err instanceof ViberApiError && err.isAuthError;
      await supabaseAdmin
        .from("viber_accounts" as never)
        .update({
          status: authFailed ? "token_invalid" : "error",
          status_reason: msg.slice(0, 500),
          last_verified_at: new Date().toISOString(),
        } as never)
        .eq("id", data.accountId);
      throw new Error(msg);
    }
  });

export const deleteViberAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { accountId: string }) =>
    z.object({ accountId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data: allowed } = await context.supabase
      .from("viber_accounts" as never)
      .select("id, workspace_id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!allowed) throw new Error("Viber bot not found");

    const { data: secretRaw } = await supabaseAdmin
      .from("viber_accounts" as never)
      .select("auth_token_ciphertext")
      .eq("id", data.accountId)
      .maybeSingle();
    const cipher = (secretRaw as unknown as { auth_token_ciphertext: string } | null)
      ?.auth_token_ciphertext;
    if (cipher) {
      try {
        const { decryptToken } = await import("@/lib/instagram/token-crypto.server");
        const { clearViberWebhook } = await import("./send.server");
        await clearViberWebhook(decryptToken(cipher));
      } catch {
        /* ignore — the row is going away regardless */
      }
    }

    const { error } = await context.supabase
      .from("viber_accounts" as never)
      .delete()
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "viber_account.delete",
      severity: "warning",
      workspaceId: (allowed as unknown as { workspace_id: string }).workspace_id,
      actorId: context.userId,
      resourceType: "viber_account",
      resourceId: data.accountId,
    });

    return { ok: true };
  });
