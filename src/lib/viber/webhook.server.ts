/**
 * Viber webhook processing — server-only.
 *
 * Viber posts every event to a per-account URL:
 *   POST /api/public/webhooks/viber/<accountId>
 *
 * Authentication is a signature, not a shared secret: Viber sends
 * `X-Viber-Content-Signature`, the hex HMAC-SHA256 of the raw body keyed with
 * the bot's own auth token. The token is stored encrypted on the account row,
 * so the comparison happens here rather than at the edge.
 *
 * Two Viber quirks shape this file:
 *   - `set_webhook` immediately POSTs a `webhook` event to the new URL and
 *     only keeps the registration if it gets a 2xx, so that event must be
 *     answered even before any account state exists.
 *   - Viber retries any non-2xx, so a poison event is logged and acked rather
 *     than left to loop.
 *
 * Inbound messages are normalised into the omnichannel inbox tables exactly
 * the way the Telegram ingest path does, so the Inbox UI needs no
 * channel-specific handling.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = { from: (t: string) => any };

import { ensureInboxThread } from "@/lib/inbox/thread-dedup.server";
import { sbAny } from "@/lib/supabase/untyped";

interface ViberAccountRow {
  id: string;
  workspace_id: string;
  bot_id: string;
  bot_name: string | null;
  auth_token_ciphertext: string;
  status: string;
}

function safeEqHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export async function handleViberWebhook(
  accountId: string,
  request: Request,
  rawBody: string,
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    return new Response("not found", { status: 404 });
  }

  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const admin = supabaseAdmin as unknown as Admin;
  const { data: acctRaw } = await supabaseAdmin
    .from("viber_accounts" as never)
    .select("id, workspace_id, bot_id, bot_name, auth_token_ciphertext, status")
    .eq("id", accountId)
    .maybeSingle();
  const account = acctRaw as unknown as ViberAccountRow | null;
  if (!account) return new Response("not found", { status: 404 });

  const { decryptToken } = await import("@/lib/instagram/token-crypto.server");
  let authToken: string;
  try {
    authToken = decryptToken(account.auth_token_ciphertext);
  } catch {
    return new Response("account token unreadable", { status: 500 });
  }

  const provided = (request.headers.get("x-viber-content-signature") ?? "").toLowerCase();
  const expected = createHmac("sha256", authToken).update(rawBody, "utf8").digest("hex");
  if (!safeEqHex(provided, expected)) {
    return new Response("invalid signature", { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const kind = typeof event.event === "string" ? event.event : "";

  // Registration ping from `set_webhook` — nothing to store, but it must be
  // acknowledged or Viber discards the webhook registration.
  if (kind === "webhook") {
    return Response.json({ status: 0, status_message: "ok" });
  }

  const messageToken = event.message_token != null ? String(event.message_token) : null;

  const { claimWebhookDelivery, completeWebhookDelivery } = await import(
    "@/lib/webhooks/idempotency.server"
  );
  const claim = await claimWebhookDelivery({
    provider: "viber",
    deliveryKey: `${account.id}:${kind}:${messageToken ?? `raw:${rawBody.length}:${Date.now()}`}`,
    workspaceId: account.workspace_id,
    payload: event,
  });
  if (!claim.fresh) return Response.json({ status: 0, status_message: "duplicate" });

  let status: "processed" | "ignored" | "failed" = "processed";
  let errorMessage: string | null = null;
  try {
    const handled = await processViberEvent(admin, account, kind, event);
    if (!handled) status = "ignored";
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[viber-webhook] processing error:", err);
  }
  await completeWebhookDelivery(claim.id, status, errorMessage);

  return Response.json({ status: 0, status_message: "ok" });
}

async function processViberEvent(
  admin: Admin,
  account: ViberAccountRow,
  kind: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  switch (kind) {
    case "message":
      return await ingestViberMessage(admin, account, event);
    case "subscribed":
    case "conversation_started":
      // Create the contact so the thread exists before the first message.
      await resolveViberContact(admin, account.workspace_id, senderOf(event));
      return true;
    case "unsubscribed":
    case "delivered":
    case "seen":
    case "failed":
      // Receipts carry no body; delivery state for outbound Viber messages is
      // tracked on our own rows, so there is nothing to persist here yet.
      return false;
    default:
      return false;
  }
}

interface ViberSender {
  id: string;
  name: string | null;
  avatar: string | null;
}

function senderOf(event: Record<string, unknown>): ViberSender {
  const raw = (event.sender as Record<string, unknown> | undefined) ?? {};
  const id = raw.id != null ? String(raw.id) : (event.user_id != null ? String(event.user_id) : "");
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
    avatar: typeof raw.avatar === "string" && raw.avatar ? raw.avatar : null,
  };
}

/** Viber message payload → the text + media_type our inbox stores. */
export function extractViberContent(message: Record<string, unknown>): {
  text: string;
  mediaType: string | null;
  mediaUrl: string | null;
} {
  const type = typeof message.type === "string" ? message.type : "";
  const text = typeof message.text === "string" ? message.text : "";
  const media = typeof message.media === "string" ? message.media : null;

  switch (type) {
    case "picture":
      return { text, mediaType: "image", mediaUrl: media };
    case "video":
      return { text, mediaType: "video", mediaUrl: media };
    case "file":
      return { text, mediaType: "document", mediaUrl: media };
    case "sticker":
      return { text, mediaType: "sticker", mediaUrl: media };
    case "location": {
      const loc = (message.location as Record<string, unknown> | undefined) ?? {};
      const lat = loc.lat ?? loc.latitude;
      const lon = loc.lon ?? loc.longitude;
      return {
        text: text || (lat != null && lon != null ? `${lat}, ${lon}` : ""),
        mediaType: "location",
        mediaUrl: null,
      };
    }
    case "contact": {
      const contact = (message.contact as Record<string, unknown> | undefined) ?? {};
      const name = typeof contact.name === "string" ? contact.name : "";
      const phone = typeof contact.phone_number === "string" ? contact.phone_number : "";
      return {
        text: text || [name, phone].filter(Boolean).join(" · "),
        mediaType: "contact",
        mediaUrl: null,
      };
    }
    case "url":
      return { text: text || media || "", mediaType: null, mediaUrl: null };
    default:
      return { text, mediaType: null, mediaUrl: null };
  }
}

async function ingestViberMessage(
  admin: Admin,
  account: ViberAccountRow,
  event: Record<string, unknown>,
): Promise<boolean> {
  const sender = senderOf(event);
  if (!sender.id) return false;

  const message = (event.message as Record<string, unknown> | undefined) ?? {};
  const { text, mediaType, mediaUrl } = extractViberContent(message);
  const providerMessageId = event.message_token != null ? String(event.message_token) : null;
  const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  const nowIso = new Date(timestamp).toISOString();
  const preview = text ? text.slice(0, 240) : mediaType ? `[${mediaType}]` : "";

  const contactId = await resolveViberContact(admin, account.workspace_id, sender);
  const externalConversationId = `viber:${account.bot_id}:${sender.id}`;

  const { conversationId } = await ensureInboxThread(admin, {
    workspaceId: account.workspace_id,
    channel: "viber",
    externalConversationId,
    accountId: account.id,
    contactId,
    inbound: true,
    preview,
    metadata: {
      source: "viber_webhook",
      bot_id: account.bot_id,
      bot_name: account.bot_name,
      viber_user_id: sender.id,
    },
  });

  if (providerMessageId) {
    const { data: dupe } = await admin
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("provider_message_id", providerMessageId)
      .limit(1)
      .maybeSingle();
    if (dupe) return true;
  }

  const { error: msgErr } = await sbAny(admin)
    .from("messages")
    .insert({
      workspace_id: account.workspace_id,
      conversation_id: conversationId,
      direction: "inbound",
      status: "delivered",
      body: text,
      media_url: mediaUrl,
      media_type: mediaType,
      message_type: mediaType ? "media" : "text",
      provider_message_id: providerMessageId,
      from_address: sender.id,
      to_address: account.bot_id,
      created_at: nowIso,
      metadata: { source: "viber_webhook", payload: event },
    });
  if (
    msgErr &&
    !String(msgErr.message ?? "")
      .toLowerCase()
      .includes("duplicate")
  ) {
    console.warn("[viber-webhook] message insert failed:", msgErr.message);
  }

  if (text.trim()) {
    try {
      await runViberChatbot(admin, account, {
        conversationId,
        contactId,
        receiver: sender.id,
        text,
      });
    } catch (err) {
      console.error("[viber-webhook] chatbot failed:", (err as Error).message);
    }
  }
  return true;
}

async function runViberChatbot(
  admin: Admin,
  account: ViberAccountRow,
  msg: { conversationId: string; contactId: string; receiver: string; text: string },
): Promise<void> {
  const { dispatchChannelBot } = await import("@/lib/chatbots/channel-dispatch.server");
  const result = await dispatchChannelBot({
    admin,
    channel: "viber",
    workspaceId: account.workspace_id,
    accountId: account.id,
    externalId: msg.receiver,
    userText: msg.text,
    conversationId: msg.conversationId,
    contactId: msg.contactId,
    sessionMetadata: { viber_account_id: account.id, bot_name: account.bot_name },
  });
  if (!result?.reply) return;

  const { sendViberMessage } = await import("./send.server");
  const sent = await sendViberMessage({
    authTokenCipher: account.auth_token_ciphertext,
    receiver: msg.receiver,
    senderName: account.bot_name,
    text: result.reply,
  });

  await sbAny(admin)
    .from("messages")
    .insert({
      workspace_id: account.workspace_id,
      conversation_id: msg.conversationId,
      direction: "outbound",
      status: "sent",
      body: result.reply,
      message_type: "text",
      provider_message_id: sent.messageToken,
      from_address: account.bot_id,
      to_address: msg.receiver,
      metadata: { source: "chatbot", chatbot_id: result.botId },
    });
}

async function resolveViberContact(
  admin: Admin,
  workspaceId: string,
  sender: ViberSender,
): Promise<string> {
  const { data: existingIdRaw } = await admin
    .from("channel_identities")
    .select("id, contact_id")
    .eq("workspace_id", workspaceId)
    .eq("channel", "viber")
    .eq("external_id", sender.id)
    .maybeSingle();
  const existingId = existingIdRaw as { id: string; contact_id: string | null } | null;

  if (existingId?.contact_id) {
    await admin
      .from("channel_identities")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existingId.id);
    return existingId.contact_id;
  }

  const { data: contactRaw, error: cErr } = await admin
    .from("contacts")
    .insert({
      workspace_id: workspaceId,
      name: sender.name ?? `Viber user ${sender.id.slice(-6)}`,
      display_name: sender.name,
      avatar_url: sender.avatar,
      source: "viber",
    })
    .select("id")
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  const contactId = (contactRaw as { id: string }).id;

  const identity = {
    workspace_id: workspaceId,
    contact_id: contactId,
    channel: "viber",
    external_id: sender.id,
    display_name: sender.name,
    avatar_url: sender.avatar,
    last_seen_at: new Date().toISOString(),
    metadata: {},
  };
  if (existingId) {
    await sbAny(admin).from("channel_identities").update(identity).eq("id", existingId.id);
  } else {
    await sbAny(admin).from("channel_identities").insert(identity);
  }
  return contactId;
}
