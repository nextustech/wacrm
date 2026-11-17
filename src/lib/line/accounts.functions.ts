/**
 * LINE Official Account management — connect, list, verify, disconnect.
 *
 * The workspace pastes the channel secret and a long-lived channel access
 * token from the LINE Developers Console. We call `/v2/bot/info` to validate
 * the token, point the channel's webhook at this deployment, and store both
 * secrets encrypted at rest.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface LineAccountSummary {
  id: string;
  bot_user_id: string;
  basic_id: string | null;
  display_name: string | null;
  picture_url: string | null;
  status: string;
  status_reason: string | null;
  connected_at: string;
  last_verified_at: string | null;
}

const ACCOUNT_COLUMNS =
  "id, bot_user_id, basic_id, display_name, picture_url, status, status_reason, connected_at, last_verified_at";

export const listLineAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { workspaceId: string }) =>
    z.object({ workspaceId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("line_accounts" as never)
      .select(ACCOUNT_COLUMNS)
      .eq("workspace_id", data.workspaceId)
      .order("connected_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { accounts: (rows ?? []) as unknown as LineAccountSummary[] };
  });

export const connectLineAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      workspaceId: string;
      channelSecret: string;
      channelAccessToken: string;
      origin: string;
    }) =>
      z
        .object({
          workspaceId: z.string().uuid(),
          channelSecret: z.string().trim().min(16).max(200),
          channelAccessToken: z.string().trim().min(40).max(1000),
          origin: z.string().url(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }) => {
    const channelSecret = data.channelSecret.trim();
    const accessToken = data.channelAccessToken.trim();

    const { getLineBotInfo, setLineWebhookEndpoint } = await import("./send.server");
    const info = await getLineBotInfo(accessToken);
    const botUserId = String(info.userId ?? "").trim();
    if (!botUserId) throw new Error("LINE accepted the token but returned no bot user id.");

    const { encryptToken } = await import("@/lib/instagram/token-crypto.server");
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");

    const { data: existingRaw } = await supabaseAdmin
      .from("line_accounts" as never)
      .select("id")
      .eq("workspace_id", data.workspaceId)
      .eq("bot_user_id", botUserId)
      .maybeSingle();
    const alreadyConnected = !!existingRaw;

    const { data: saved, error } = await supabaseAdmin
      .from("line_accounts" as never)
      .upsert(
        {
          workspace_id: data.workspaceId,
          bot_user_id: botUserId,
          basic_id: info.basicId ?? null,
          display_name: info.displayName ?? null,
          picture_url: info.pictureUrl ?? null,
          channel_secret_ciphertext: encryptToken(channelSecret),
          channel_access_token_ciphertext: encryptToken(accessToken),
          status: "connected",
          status_reason: null,
          connected_by: context.userId,
          last_verified_at: new Date().toISOString(),
        } as never,
        { onConflict: "workspace_id,bot_user_id" },
      )
      .select(ACCOUNT_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const account = saved as unknown as LineAccountSummary | null;
    if (!account) throw new Error("Could not save the LINE account");

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "line_account.connect",
      severity: "info",
      workspaceId: data.workspaceId,
      actorId: context.userId,
      resourceType: "line_account",
      resourceId: account.id,
      data: { bot_user_id: botUserId, basic_id: info.basicId ?? null },
    });

    const webhookUrl = `${data.origin.replace(/\/$/, "")}/api/public/webhooks/line/${account.id}`;
    try {
      await setLineWebhookEndpoint(accessToken, webhookUrl);
    } catch (err) {
      await supabaseAdmin
        .from("line_accounts" as never)
        .update({
          status: "webhook_not_set",
          status_reason: (err as Error).message.slice(0, 500),
        } as never)
        .eq("id", account.id);
      throw new Error(
        `Token verified, but setting the webhook failed: ${(err as Error).message}. ` +
          "A long-lived channel access token issued from the console is required for this call.",
      );
    }

    return { account, webhookUrl, alreadyConnected, displayName: info.displayName ?? null };
  });

export const verifyLineAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { accountId: string; origin: string }) =>
    z.object({ accountId: z.string().uuid(), origin: z.string().url() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rowRaw, error } = await context.supabase
      .from("line_accounts" as never)
      .select("id, workspace_id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!rowRaw) throw new Error("LINE account not found");

    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data: secretRaw } = await supabaseAdmin
      .from("line_accounts" as never)
      .select("channel_access_token_ciphertext")
      .eq("id", data.accountId)
      .maybeSingle();
    const cipher = (secretRaw as unknown as { channel_access_token_ciphertext: string } | null)
      ?.channel_access_token_ciphertext;
    if (!cipher) throw new Error("Stored access token missing — reconnect the account");

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "secrets.view",
      severity: "warning",
      workspaceId: (rowRaw as unknown as { workspace_id: string }).workspace_id,
      actorId: context.userId,
      resourceType: "line_account",
      resourceId: data.accountId,
    });

    const { decryptToken } = await import("@/lib/instagram/token-crypto.server");
    const { getLineBotInfo, getLineWebhookEndpoint, setLineWebhookEndpoint, LineApiError } =
      await import("./send.server");
    const expected = `${data.origin.replace(/\/$/, "")}/api/public/webhooks/line/${data.accountId}`;

    try {
      const accessToken = decryptToken(cipher);
      const info = await getLineBotInfo(accessToken);
      const current = await getLineWebhookEndpoint(accessToken);
      let endpoint = current.endpoint;
      if (endpoint !== expected) {
        await setLineWebhookEndpoint(accessToken, expected);
        endpoint = expected;
      }
      await supabaseAdmin
        .from("line_accounts" as never)
        .update({
          basic_id: info.basicId ?? null,
          display_name: info.displayName ?? null,
          picture_url: info.pictureUrl ?? null,
          status: "connected",
          status_reason: null,
          last_verified_at: new Date().toISOString(),
        } as never)
        .eq("id", data.accountId);
      return { ok: true, status: "connected", webhookUrl: endpoint, expectedUrl: expected };
    } catch (err) {
      const msg = (err as Error).message;
      const authFailed = err instanceof LineApiError && err.isAuthError;
      await supabaseAdmin
        .from("line_accounts" as never)
        .update({
          status: authFailed ? "token_invalid" : "error",
          status_reason: msg.slice(0, 500),
          last_verified_at: new Date().toISOString(),
        } as never)
        .eq("id", data.accountId);
      throw new Error(msg);
    }
  });

export const deleteLineAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { accountId: string }) =>
    z.object({ accountId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: allowed } = await context.supabase
      .from("line_accounts" as never)
      .select("id, workspace_id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!allowed) throw new Error("LINE account not found");

    const { error } = await context.supabase
      .from("line_accounts" as never)
      .delete()
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "line_account.delete",
      severity: "warning",
      workspaceId: (allowed as unknown as { workspace_id: string }).workspace_id,
      actorId: context.userId,
      resourceType: "line_account",
      resourceId: data.accountId,
    });

    return { ok: true };
  });
