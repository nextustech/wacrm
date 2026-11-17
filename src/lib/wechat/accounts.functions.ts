/**
 * WeChat Official Account management — connect, list, verify, disconnect.
 *
 * The workspace pastes AppID, AppSecret and the webhook Token it entered in
 * the WeChat MP console. We exchange AppID/AppSecret for an access token to
 * prove the credentials work, then wait for WeChat to call the webhook: there
 * is no API that registers the URL, so the account stays `pending_webhook`
 * until the console's own check hits our endpoint.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface WeChatAccountSummary {
  id: string;
  app_id: string;
  account_name: string | null;
  original_id: string | null;
  status: string;
  status_reason: string | null;
  connected_at: string;
  last_verified_at: string | null;
}

const ACCOUNT_COLUMNS =
  "id, app_id, account_name, original_id, status, status_reason, connected_at, last_verified_at";

export const listWeChatAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { workspaceId: string }) =>
    z.object({ workspaceId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("wechat_accounts" as never)
      .select(ACCOUNT_COLUMNS)
      .eq("workspace_id", data.workspaceId)
      .order("connected_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { accounts: (rows ?? []) as unknown as WeChatAccountSummary[] };
  });

export const connectWeChatAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      workspaceId: string;
      appId: string;
      appSecret: string;
      webhookToken: string;
      accountName?: string;
      originalId?: string;
      origin: string;
    }) =>
      z
        .object({
          workspaceId: z.string().uuid(),
          appId: z.string().trim().min(10).max(64),
          appSecret: z.string().trim().min(16).max(128),
          // WeChat limits the console Token to 3–32 alphanumeric characters.
          webhookToken: z
            .string()
            .trim()
            .min(3)
            .max(32)
            .regex(/^[A-Za-z0-9]+$/, "The Token must be 3–32 letters and digits only."),
          accountName: z.string().trim().max(120).optional(),
          originalId: z.string().trim().max(64).optional(),
          origin: z.string().url(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { fetchWeChatAccessToken } = await import("./send.server");
    // Proves AppID + AppSecret before anything is stored.
    const token = await fetchWeChatAccessToken(data.appId, data.appSecret);

    const { encryptToken } = await import("@/lib/instagram/token-crypto.server");
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");

    const { data: existingRaw } = await supabaseAdmin
      .from("wechat_accounts" as never)
      .select("id, status")
      .eq("workspace_id", data.workspaceId)
      .eq("app_id", data.appId)
      .maybeSingle();
    const existing = existingRaw as unknown as { id: string; status: string } | null;

    const { data: saved, error } = await supabaseAdmin
      .from("wechat_accounts" as never)
      .upsert(
        {
          workspace_id: data.workspaceId,
          app_id: data.appId,
          account_name: data.accountName ?? null,
          original_id: data.originalId ?? null,
          app_secret_ciphertext: encryptToken(data.appSecret),
          webhook_token_ciphertext: encryptToken(data.webhookToken),
          access_token_ciphertext: encryptToken(token.accessToken),
          access_token_expires_at: token.expiresAt.toISOString(),
          // Only WeChat calling our URL can confirm the webhook half.
          status: existing?.status === "connected" ? "connected" : "pending_webhook",
          status_reason: null,
          connected_by: context.userId,
          last_verified_at: new Date().toISOString(),
        } as never,
        { onConflict: "workspace_id,app_id" },
      )
      .select(ACCOUNT_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const account = saved as unknown as WeChatAccountSummary | null;
    if (!account) throw new Error("Could not save the WeChat account");

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "wechat_account.connect",
      severity: "info",
      workspaceId: data.workspaceId,
      actorId: context.userId,
      resourceType: "wechat_account",
      resourceId: account.id,
      data: { app_id: data.appId },
    });

    return {
      account,
      webhookUrl: `${data.origin.replace(/\/$/, "")}/api/public/webhooks/wechat/${account.id}`,
      alreadyConnected: !!existing,
    };
  });

export const verifyWeChatAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { accountId: string; origin: string }) =>
    z.object({ accountId: z.string().uuid(), origin: z.string().url() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rowRaw, error } = await context.supabase
      .from("wechat_accounts" as never)
      .select("id, workspace_id, status")
      .eq("id", data.accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = rowRaw as unknown as { workspace_id: string; status: string } | null;
    if (!row) throw new Error("WeChat account not found");

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "secrets.view",
      severity: "warning",
      workspaceId: row.workspace_id,
      actorId: context.userId,
      resourceType: "wechat_account",
      resourceId: data.accountId,
    });

    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { getWeChatAccessToken, WeChatApiError } = await import("./send.server");
    const expected = `${data.origin.replace(/\/$/, "")}/api/public/webhooks/wechat/${data.accountId}`;

    try {
      // Refreshes the cached token when needed; failure means bad credentials.
      await getWeChatAccessToken(data.accountId);
      // The webhook half is only ever confirmed by WeChat calling our GET
      // endpoint, so a pending account stays pending here.
      const nextStatus = row.status === "connected" ? "connected" : "pending_webhook";
      await supabaseAdmin
        .from("wechat_accounts" as never)
        .update({
          status: nextStatus,
          status_reason:
            nextStatus === "connected"
              ? null
              : "Credentials are valid. Save this URL as the Server Address in the WeChat MP console to finish.",
          last_verified_at: new Date().toISOString(),
        } as never)
        .eq("id", data.accountId);
      return { ok: nextStatus === "connected", status: nextStatus, expectedUrl: expected };
    } catch (err) {
      const msg = (err as Error).message;
      const authFailed = err instanceof WeChatApiError && err.isAuthError;
      await supabaseAdmin
        .from("wechat_accounts" as never)
        .update({
          status: authFailed ? "token_invalid" : "error",
          status_reason: msg.slice(0, 500),
          last_verified_at: new Date().toISOString(),
        } as never)
        .eq("id", data.accountId);
      throw new Error(msg);
    }
  });

export const deleteWeChatAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { accountId: string }) =>
    z.object({ accountId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: allowed } = await context.supabase
      .from("wechat_accounts" as never)
      .select("id, workspace_id")
      .eq("id", data.accountId)
      .maybeSingle();
    if (!allowed) throw new Error("WeChat account not found");

    const { error } = await context.supabase
      .from("wechat_accounts" as never)
      .delete()
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);

    const { recordServerAuditEvent } = await import("@/lib/security/audit.server");
    void recordServerAuditEvent({
      eventType: "wechat_account.delete",
      severity: "warning",
      workspaceId: (allowed as unknown as { workspace_id: string }).workspace_id,
      actorId: context.userId,
      resourceType: "wechat_account",
      resourceId: data.accountId,
    });

    return { ok: true };
  });
