import type { ChannelProvider } from "../channel";
import type { OutboundDraft, ChannelAccountRef, SendResult } from "../../types";

/**
 * Viber Bot channel.
 *
 * Accounts live in `viber_accounts` (one row per bot, auth token encrypted at
 * rest). Inbound events arrive at `/api/public/webhooks/viber/<accountId>` and
 * are normalized by `src/lib/viber/webhook.server.ts`, which writes straight
 * into the omnichannel inbox tables.
 */
export const viberChannel: ChannelProvider = {
  kind: "viber",
  label: "Viber",
  implemented: true,
  capabilities: new Set([
    "text",
    "emoji",
    "image",
    "video",
    "audio",
    "document",
    "location",
    "contact_card",
    "interactive_buttons",
  ]),
  extractAccountRouting() {
    // Viber events carry no bot id — routing is the per-account webhook path,
    // and the signature header proves which bot signed it.
    return null;
  },
  async parseWebhook() {
    // Ingestion is owned by src/lib/viber/webhook.server.ts, which persists
    // directly; nothing is handed back through the registry seam.
    return [];
  },
  async send(draft: OutboundDraft, account: ChannelAccountRef): Promise<SendResult> {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { data } = await supabaseAdmin
      .from("viber_accounts" as never)
      .select("auth_token_ciphertext, bot_name, status, status_reason")
      .eq("id", account.id)
      .maybeSingle();
    const row = data as unknown as {
      auth_token_ciphertext?: string;
      bot_name?: string | null;
      status?: string;
      status_reason?: string | null;
    } | null;
    const cipher = row?.auth_token_ciphertext;
    if (!cipher) throw new Error("viber: auth token missing for this account");
    if (row?.status && row.status !== "connected") {
      throw new Error(
        `viber: bot is not connected (${row.status})${row.status_reason ? ` — ${row.status_reason}` : ""}. Reconnect or verify the bot in Settings → Viber.`,
      );
    }

    const { sendViberMessage, ViberApiError } = await import("@/lib/viber/send.server");
    const media = draft.media?.url
      ? {
          url: draft.media.url,
          kind:
            draft.type === "image"
              ? ("picture" as const)
              : draft.type === "video"
                ? ("video" as const)
                : ("file" as const),
        }
      : null;

    try {
      const res = await sendViberMessage({
        authTokenCipher: cipher,
        receiver: draft.to,
        senderName: row?.bot_name ?? null,
        text: draft.text ?? null,
        media,
      });
      return { providerMessageId: res.messageToken, status: "sent" };
    } catch (err) {
      if (err instanceof ViberApiError && err.isAuthError) {
        await supabaseAdmin
          .from("viber_accounts" as never)
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
