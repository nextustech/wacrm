import type { ChannelProvider } from "../channel";
import type { OutboundDraft, ChannelAccountRef, SendResult } from "../../types";

/**
 * LINE Messaging API channel.
 *
 * Accounts live in `line_accounts` (channel secret + channel access token,
 * both encrypted at rest). Inbound events arrive at
 * `/api/public/webhooks/line/<accountId>` and are normalized by
 * `src/lib/line/webhook.server.ts`, which writes straight into the
 * omnichannel inbox tables.
 */
export const lineChannel: ChannelProvider = {
  kind: "line",
  label: "LINE",
  implemented: true,
  capabilities: new Set([
    "text",
    "emoji",
    "image",
    "video",
    "audio",
    "location",
    "interactive_buttons",
    "template",
  ]),
  extractAccountRouting() {
    // The batch carries `destination` (the bot user id), but routing is the
    // per-account webhook path plus the channel-secret signature.
    return null;
  },
  async parseWebhook() {
    // Ingestion is owned by src/lib/line/webhook.server.ts, which persists
    // directly; nothing is handed back through the registry seam.
    return [];
  },
  async send(draft: OutboundDraft, account: ChannelAccountRef): Promise<SendResult> {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data } = await supabaseAdmin
      .from("line_accounts" as never)
      .select("channel_access_token_ciphertext, status, status_reason")
      .eq("id", account.id)
      .maybeSingle();
    const row = data as unknown as {
      channel_access_token_ciphertext?: string;
      status?: string;
      status_reason?: string | null;
    } | null;
    const cipher = row?.channel_access_token_ciphertext;
    if (!cipher) throw new Error("line: channel access token missing for this account");
    if (row?.status && row.status !== "connected") {
      throw new Error(
        `line: account is not connected (${row.status})${row.status_reason ? ` — ${row.status_reason}` : ""}. Reconnect or verify it in Settings → LINE.`,
      );
    }

    const { sendLineMessage, LineApiError } = await import("@/lib/line/send.server");
    const isDocument = Boolean(draft.media?.url) && draft.type === "document";
    const media =
      draft.media?.url && !isDocument
        ? {
            url: draft.media.url,
            kind:
              draft.type === "image"
                ? ("image" as const)
                : draft.type === "video"
                  ? ("video" as const)
                  : ("audio" as const),
          }
        : null;

    try {
      const res = await sendLineMessage({
        accessTokenCipher: cipher,
        to: draft.to,
        text: draft.text ?? null,
        media,
        // LINE has no outbound file message; a document goes out as a link.
        documentUrl: isDocument ? (draft.media?.url ?? null) : null,
      });
      return { providerMessageId: res.messageId, status: "sent" };
    } catch (err) {
      if (err instanceof LineApiError && err.isAuthError) {
        await supabaseAdmin
          .from("line_accounts" as never)
          .update({
            status: "token_invalid",
            status_reason: err.message.slice(0, 500),
          } as never)
          .eq("id", account.id);
      }
      throw err;
    }
  },
};
