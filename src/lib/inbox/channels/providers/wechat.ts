import type { ChannelProvider } from "../channel";
import type { OutboundDraft, ChannelAccountRef, SendResult } from "../../types";

/**
 * WeChat Official Account channel.
 *
 * Accounts live in `wechat_accounts` (AppSecret, webhook Token and a cached
 * access token, all encrypted at rest). Inbound XML arrives at
 * `/api/public/webhooks/wechat/<accountId>` and is normalized by
 * `src/lib/wechat/webhook.server.ts`, which writes straight into the
 * omnichannel inbox tables.
 *
 * Outbound is the customer-service API, which WeChat only allows within 48
 * hours of the user's last message.
 */
export const wechatChannel: ChannelProvider = {
  kind: "wechat",
  label: "WeChat",
  implemented: true,
  capabilities: new Set(["text", "emoji", "image", "video", "audio", "location"]),
  extractAccountRouting() {
    // Routing is the per-account webhook path; the signature proves the token.
    return null;
  },
  async parseWebhook() {
    // Ingestion is owned by src/lib/wechat/webhook.server.ts, which persists
    // directly; nothing is handed back through the registry seam.
    return [];
  },
  async send(draft: OutboundDraft, account: ChannelAccountRef): Promise<SendResult> {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data } = await supabaseAdmin
      .from("wechat_accounts" as never)
      .select("status, status_reason")
      .eq("id", account.id)
      .maybeSingle();
    const row = data as unknown as { status?: string; status_reason?: string | null } | null;
    if (!row) throw new Error("wechat: account not found");
    if (row.status && row.status !== "connected") {
      throw new Error(
        `wechat: account is not connected (${row.status})${row.status_reason ? ` — ${row.status_reason}` : ""}. Finish setup in Settings → WeChat.`,
      );
    }

    const { sendWeChatMessage, WeChatApiError } = await import("@/lib/wechat/send.server");
    try {
      // Media must already be a WeChat `media_id`; an arbitrary URL cannot be
      // sent, so anything else goes out as text.
      const res = await sendWeChatMessage({
        accountId: account.id,
        toUser: draft.to,
        text: draft.text ?? null,
      });
      return { providerMessageId: res.messageId, status: "sent" };
    } catch (err) {
      if (err instanceof WeChatApiError && err.isWindowClosed) {
        throw new Error(
          "wechat: the 48-hour reply window has closed — WeChat only allows a template message now.",
        );
      }
      if (err instanceof WeChatApiError && err.isAuthError) {
        await supabaseAdmin
          .from("wechat_accounts" as never)
          .update({
            status: "token_invalid",
            status_reason: err.message.slice(0, 500),
            // Force a refresh on the next send.
            access_token_ciphertext: null,
            access_token_expires_at: null,
          } as never)
          .eq("id", account.id);
      }
      throw err;
    }
  },
};
