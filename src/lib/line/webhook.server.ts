/**
 * LINE webhook processing — server-only.
 *
 * LINE posts every event batch to a per-account URL:
 *   POST /api/public/webhooks/line/<accountId>
 *
 * Authentication is a signature: `X-Line-Signature` is the base64
 * HMAC-SHA256 of the raw body keyed with the *channel secret* (not the access
 * token). The secret is stored encrypted on the account row.
 *
 * Two LINE quirks shape this file:
 *   - "Verify" in the LINE Developers Console sends a signed body with an
 *     empty `events` array, and a real event batch can carry several events;
 *     both must answer 200.
 *   - Each event brings a single-use `replyToken` that makes the first reply
 *     free. It is handed to the chatbot path so an auto-reply does not burn a
 *     billed push message.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = { from: (t: string) => any };

import { ensureInboxThread } from "@/lib/inbox/thread-dedup.server";
import { sbAny } from "@/lib/supabase/untyped";

interface LineAccountRow {
  id: string;
  workspace_id: string;
  bot_user_id: string;
  display_name: string | null;
  channel_secret_ciphertext: string;
  channel_access_token_ciphertext: string;
  status: string;
}

function safeEqB64(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export async function handleLineWebhook(
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
    .from("line_accounts" as never)
    .select(
      "id, workspace_id, bot_user_id, display_name, channel_secret_ciphertext, channel_access_token_ciphertext, status",
    )
    .eq("id", accountId)
    .maybeSingle();
  const account = acctRaw as unknown as LineAccountRow | null;
  if (!account) return new Response("not found", { status: 404 });

  const { decryptToken } = await import("@/lib/instagram/token-crypto.server");
  let channelSecret: string;
  try {
    channelSecret = decryptToken(account.channel_secret_ciphertext);
  } catch {
    return new Response("account secret unreadable", { status: 500 });
  }

  const provided = request.headers.get("x-line-signature") ?? "";
  const expected = createHmac("sha256", channelSecret).update(rawBody, "utf8").digest("base64");
  if (!safeEqB64(provided, expected)) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: { events?: Array<Record<string, unknown>> };
  try {
    body = JSON.parse(rawBody) as { events?: Array<Record<string, unknown>> };
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  // The console's "Verify" button posts a signed, empty batch.
  if (events.length === 0) return Response.json({ ok: true });

  const { claimWebhookDelivery, completeWebhookDelivery } = await import(
    "@/lib/webhooks/idempotency.server"
  );

  for (const event of events) {
    const eventId =
      typeof event.webhookEventId === "string"
        ? event.webhookEventId
        : `${account.id}:${String(event.timestamp ?? Date.now())}`;

    const claim = await claimWebhookDelivery({
      provider: "line",
      deliveryKey: `${account.id}:${eventId}`,
      workspaceId: account.workspace_id,
      payload: event,
    });
    if (!claim.fresh) continue;

    let status: "processed" | "ignored" | "failed" = "processed";
    let errorMessage: string | null = null;
    try {
      const handled = await processLineEvent(admin, account, event);
      if (!handled) status = "ignored";
    } catch (err) {
      status = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error("[line-webhook] processing error:", err);
    }
    await completeWebhookDelivery(claim.id, status, errorMessage);
  }

  return Response.json({ ok: true });
}

async function processLineEvent(
  admin: Admin,
  account: LineAccountRow,
  event: Record<string, unknown>,
): Promise<boolean> {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "message":
      return await ingestLineMessage(admin, account, event);
    case "follow":
      await resolveLineContact(admin, account, sourceUserId(event));
      return true;
    case "unfollow":
    case "join":
    case "leave":
    case "postback":
    default:
      return false;
  }
}

function sourceUserId(event: Record<string, unknown>): string {
  const source = (event.source as Record<string, unknown> | undefined) ?? {};
  return typeof source.userId === "string" ? source.userId : "";
}

/** LINE message payload → the text + media_type our inbox stores. */
export function extractLineContent(message: Record<string, unknown>): {
  text: string;
  mediaType: string | null;
} {
  const type = typeof message.type === "string" ? message.type : "";
  switch (type) {
    case "text":
      return { text: typeof message.text === "string" ? message.text : "", mediaType: null };
    case "image":
      return { text: "", mediaType: "image" };
    case "video":
      return { text: "", mediaType: "video" };
    case "audio":
      return { text: "", mediaType: "audio" };
    case "file":
      return {
        text: typeof message.fileName === "string" ? message.fileName : "",
        mediaType: "document",
      };
    case "sticker":
      return { text: "", mediaType: "sticker" };
    case "location": {
      const title = typeof message.title === "string" ? message.title : "";
      const address = typeof message.address === "string" ? message.address : "";
      return { text: [title, address].filter(Boolean).join(" · "), mediaType: "location" };
    }
    default:
      return { text: "", mediaType: null };
  }
}

async function ingestLineMessage(
  admin: Admin,
  account: LineAccountRow,
  event: Record<string, unknown>,
): Promise<boolean> {
  const userId = sourceUserId(event);
  if (!userId) return false; // group/room events without a user are not threads we own

  const message = (event.message as Record<string, unknown> | undefined) ?? {};
  const { text, mediaType } = extractLineContent(message);
  const providerMessageId = message.id != null ? String(message.id) : null;
  const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  const nowIso = new Date(timestamp).toISOString();
  const preview = text ? text.slice(0, 240) : mediaType ? `[${mediaType}]` : "";
  const replyToken = typeof event.replyToken === "string" ? event.replyToken : null;

  const contactId = await resolveLineContact(admin, account, userId);
  const externalConversationId = `line:${account.bot_user_id}:${userId}`;

  const { conversationId } = await ensureInboxThread(admin, {
    workspaceId: account.workspace_id,
    channel: "line",
    externalConversationId,
    accountId: account.id,
    contactId,
    inbound: true,
    preview,
    metadata: {
      source: "line_webhook",
      bot_user_id: account.bot_user_id,
      display_name: account.display_name,
      line_user_id: userId,
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
      media_type: mediaType,
      message_type: mediaType ? "media" : "text",
      provider_message_id: providerMessageId,
      from_address: userId,
      to_address: account.bot_user_id,
      created_at: nowIso,
      // Binary content stays on LINE's side; `message.id` is what the content
      // endpoint needs if the file is fetched later.
      metadata: { source: "line_webhook", payload: event },
    });
  if (
    msgErr &&
    !String(msgErr.message ?? "")
      .toLowerCase()
      .includes("duplicate")
  ) {
    console.warn("[line-webhook] message insert failed:", msgErr.message);
  }

  if (text.trim()) {
    try {
      await runLineChatbot(admin, account, {
        conversationId,
        contactId,
        userId,
        text,
        replyToken,
      });
    } catch (err) {
      console.error("[line-webhook] chatbot failed:", (err as Error).message);
    }
  }
  return true;
}

async function runLineChatbot(
  admin: Admin,
  account: LineAccountRow,
  msg: {
    conversationId: string;
    contactId: string;
    userId: string;
    text: string;
    replyToken: string | null;
  },
): Promise<void> {
  const { dispatchChannelBot } = await import("@/lib/chatbots/channel-dispatch.server");
  const result = await dispatchChannelBot({
    admin,
    channel: "line",
    workspaceId: account.workspace_id,
    accountId: account.id,
    externalId: msg.userId,
    userText: msg.text,
    conversationId: msg.conversationId,
    contactId: msg.contactId,
    sessionMetadata: { line_account_id: account.id, bot_user_id: account.bot_user_id },
  });
  if (!result?.reply) return;

  const { sendLineMessage } = await import("./send.server");
  const sent = await sendLineMessage({
    accessTokenCipher: account.channel_access_token_ciphertext,
    to: msg.userId,
    // Free when it is still valid; sendLineMessage falls back to push.
    replyToken: msg.replyToken,
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
      provider_message_id: sent.messageId || null,
      from_address: account.bot_user_id,
      to_address: msg.userId,
      metadata: { source: "chatbot", chatbot_id: result.botId },
    });
}

async function resolveLineContact(
  admin: Admin,
  account: LineAccountRow,
  userId: string,
): Promise<string> {
  const workspaceId = account.workspace_id;
  const { data: existingIdRaw } = await admin
    .from("channel_identities")
    .select("id, contact_id")
    .eq("workspace_id", workspaceId)
    .eq("channel", "line")
    .eq("external_id", userId)
    .maybeSingle();
  const existingId = existingIdRaw as { id: string; contact_id: string | null } | null;

  if (existingId?.contact_id) {
    await admin
      .from("channel_identities")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existingId.id);
    return existingId.contact_id;
  }

  // The display name is not on the event — one profile lookup per new contact.
  let displayName: string | null = null;
  let avatarUrl: string | null = null;
  try {
    const { decryptToken } = await import("@/lib/instagram/token-crypto.server");
    const { getLineProfile } = await import("./send.server");
    const profile = await getLineProfile(
      decryptToken(account.channel_access_token_ciphertext),
      userId,
    );
    displayName = profile?.displayName ?? null;
    avatarUrl = profile?.pictureUrl ?? null;
  } catch {
    /* a nameless contact is better than a dropped message */
  }

  const { data: contactRaw, error: cErr } = await admin
    .from("contacts")
    .insert({
      workspace_id: workspaceId,
      name: displayName ?? `LINE user ${userId.slice(-6)}`,
      display_name: displayName,
      avatar_url: avatarUrl,
      source: "line",
    })
    .select("id")
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  const contactId = (contactRaw as { id: string }).id;

  const identity = {
    workspace_id: workspaceId,
    contact_id: contactId,
    channel: "line",
    external_id: userId,
    display_name: displayName,
    avatar_url: avatarUrl,
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
