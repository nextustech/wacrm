/**
 * WeChat Official Account webhook processing — server-only.
 *
 *   GET  /api/public/webhooks/wechat/<accountId>  → URL validation
 *   POST /api/public/webhooks/wechat/<accountId>  → inbound XML events
 *
 * Authentication is WeChat's signature scheme: sha1 of [token, timestamp,
 * nonce] sorted lexicographically and concatenated, compared with the
 * `signature` query parameter. The token is the one entered in the WeChat MP
 * console and stored encrypted on the account row.
 *
 * WeChat quirks that shape this file:
 *   - Validation is a GET that must echo the `echostr` parameter verbatim,
 *     body-only. Getting this wrong is why a console save fails.
 *   - Inbound bodies are XML, not JSON, and are answered with either an empty
 *     body or `success` within 5 seconds. Anything slower makes WeChat retry
 *     (three times) and show the account owner a warning, so the reply here
 *     is always immediate and sending happens over the customer-service API.
 *   - "Safe mode" wraps the XML in an AES envelope. That is not supported
 *     yet; such an account is marked so the UI can say to use plaintext mode.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = { from: (t: string) => any };

import { ensureInboxThread } from "@/lib/inbox/thread-dedup.server";
import { sbAny } from "@/lib/supabase/untyped";

interface WeChatAccountRow {
  id: string;
  workspace_id: string;
  app_id: string;
  account_name: string | null;
  webhook_token_ciphertext: string;
  status: string;
}

function safeEqHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** WeChat's signature: sha1 of the three values sorted and concatenated. */
export function wechatSignature(token: string, timestamp: string, nonce: string): string {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

/**
 * Minimal XML reader for WeChat's flat, one-level message envelopes. A full
 * parser would be a dependency for no gain: every field is a direct child of
 * `<xml>` and either CDATA-wrapped text or a number.
 */
export function parseWeChatXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  // The plain-text branch is `[^<]*`, not `[sS]*?`: a lazy any-char
  // branch lets the outer <xml> wrapper match the whole document in one go,
  // consuming every field inside it and returning nothing.
  const re = /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1]!;
    if (key === "xml") continue;
    out[key] = (m[2] ?? m[3] ?? "").trim();
  }
  return out;
}

async function loadAccount(accountId: string): Promise<{
  account: WeChatAccountRow;
  token: string;
} | null> {
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data } = await supabaseAdmin
    .from("wechat_accounts" as never)
    .select("id, workspace_id, app_id, account_name, webhook_token_ciphertext, status")
    .eq("id", accountId)
    .maybeSingle();
  const account = data as unknown as WeChatAccountRow | null;
  if (!account) return null;
  const { decryptToken } = await import("@/lib/instagram/token-crypto.server");
  try {
    return { account, token: decryptToken(account.webhook_token_ciphertext) };
  } catch {
    return null;
  }
}

function signatureOk(url: URL, token: string): boolean {
  const signature = url.searchParams.get("signature") ?? "";
  const timestamp = url.searchParams.get("timestamp") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!signature || !timestamp || !nonce) return false;
  return safeEqHex(signature, wechatSignature(token, timestamp, nonce));
}

/** GET — the console's "Submit" check. Echo `echostr` and nothing else. */
export async function handleWeChatVerification(
  accountId: string,
  request: Request,
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return new Response("not found", { status: 404 });
  const loaded = await loadAccount(accountId);
  if (!loaded) return new Response("not found", { status: 404 });

  const url = new URL(request.url);
  if (!signatureOk(url, loaded.token)) return new Response("invalid signature", { status: 401 });

  const echostr = url.searchParams.get("echostr") ?? "";

  // Reaching here means the console's check passed, so the account is live.
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  await supabaseAdmin
    .from("wechat_accounts" as never)
    .update({
      status: "connected",
      status_reason: null,
      last_verified_at: new Date().toISOString(),
    } as never)
    .eq("id", accountId);

  return new Response(echostr, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** POST — an inbound message or event, as XML. */
export async function handleWeChatWebhook(
  accountId: string,
  request: Request,
  rawBody: string,
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return new Response("not found", { status: 404 });
  const loaded = await loadAccount(accountId);
  if (!loaded) return new Response("not found", { status: 404 });
  const { account, token } = loaded;

  const url = new URL(request.url);
  if (!signatureOk(url, token)) return new Response("invalid signature", { status: 401 });

  const fields = parseWeChatXml(rawBody);

  // Safe mode: the real message sits inside <Encrypt>, AES-encrypted with the
  // EncodingAESKey. Decryption is not implemented, so say so loudly on the
  // account instead of silently dropping every message.
  if (fields.Encrypt && !fields.MsgType) {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    await supabaseAdmin
      .from("wechat_accounts" as never)
      .update({
        status: "error",
        status_reason:
          "Encrypted (safe) mode is not supported yet — set the message mode to plaintext in the WeChat MP console.",
      } as never)
      .eq("id", account.id);
    return new Response("success");
  }

  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const admin = supabaseAdmin as unknown as Admin;

  const deliveryKey =
    fields.MsgId || `${account.id}:${fields.FromUserName ?? ""}:${fields.CreateTime ?? Date.now()}`;
  const { claimWebhookDelivery, completeWebhookDelivery } = await import(
    "@/lib/webhooks/idempotency.server"
  );
  const claim = await claimWebhookDelivery({
    provider: "wechat",
    deliveryKey: `${account.id}:${deliveryKey}`,
    workspaceId: account.workspace_id,
    payload: fields,
  });
  // WeChat retries a delivery up to three times; "success" stops it.
  if (!claim.fresh) return new Response("success");

  let status: "processed" | "ignored" | "failed" = "processed";
  let errorMessage: string | null = null;
  try {
    const handled = await processWeChatEvent(admin, account, fields);
    if (!handled) status = "ignored";
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[wechat-webhook] processing error:", err);
  }
  await completeWebhookDelivery(claim.id, status, errorMessage);

  // Always a fast, empty ack: replies go out over the customer-service API so
  // nothing here can breach WeChat's 5-second budget.
  return new Response("success");
}

async function processWeChatEvent(
  admin: Admin,
  account: WeChatAccountRow,
  fields: Record<string, string>,
): Promise<boolean> {
  const msgType = fields.MsgType ?? "";
  if (msgType === "event") {
    const ev = (fields.Event ?? "").toLowerCase();
    if (ev === "subscribe") {
      await resolveWeChatContact(admin, account, fields.FromUserName ?? "");
      return true;
    }
    return false;
  }
  return await ingestWeChatMessage(admin, account, fields);
}

/** WeChat message fields → the text + media_type our inbox stores. */
export function extractWeChatContent(fields: Record<string, string>): {
  text: string;
  mediaType: string | null;
  mediaId: string | null;
} {
  switch (fields.MsgType) {
    case "text":
      return { text: fields.Content ?? "", mediaType: null, mediaId: null };
    case "image":
      return { text: "", mediaType: "image", mediaId: fields.MediaId ?? null };
    case "voice":
      // WeChat ships a speech-recognition transcript when the feature is on.
      return { text: fields.Recognition ?? "", mediaType: "voice", mediaId: fields.MediaId ?? null };
    case "video":
    case "shortvideo":
      return { text: "", mediaType: "video", mediaId: fields.MediaId ?? null };
    case "location":
      return {
        text: fields.Label ?? [fields.Location_X, fields.Location_Y].filter(Boolean).join(", "),
        mediaType: "location",
        mediaId: null,
      };
    case "link":
      return {
        text: [fields.Title, fields.Description, fields.Url].filter(Boolean).join("\n"),
        mediaType: null,
        mediaId: null,
      };
    default:
      return { text: "", mediaType: null, mediaId: null };
  }
}

async function ingestWeChatMessage(
  admin: Admin,
  account: WeChatAccountRow,
  fields: Record<string, string>,
): Promise<boolean> {
  const openId = fields.FromUserName ?? "";
  if (!openId) return false;

  const { text, mediaType, mediaId } = extractWeChatContent(fields);
  const providerMessageId = fields.MsgId || null;
  const createTime = Number(fields.CreateTime);
  const nowIso = new Date(
    Number.isFinite(createTime) && createTime > 0 ? createTime * 1000 : Date.now(),
  ).toISOString();
  const preview = text ? text.slice(0, 240) : mediaType ? `[${mediaType}]` : "";

  const contactId = await resolveWeChatContact(admin, account, openId);
  const externalConversationId = `wechat:${account.app_id}:${openId}`;

  const { conversationId } = await ensureInboxThread(admin, {
    workspaceId: account.workspace_id,
    channel: "wechat",
    externalConversationId,
    accountId: account.id,
    contactId,
    inbound: true,
    preview,
    metadata: {
      source: "wechat_webhook",
      app_id: account.app_id,
      account_name: account.account_name,
      open_id: openId,
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
      from_address: openId,
      to_address: account.app_id,
      created_at: nowIso,
      // Binary content stays on WeChat's side; `media_id` is what the media
      // endpoint needs, and it expires after three days.
      metadata: { source: "wechat_webhook", media_id: mediaId, payload: fields },
    });
  if (
    msgErr &&
    !String(msgErr.message ?? "")
      .toLowerCase()
      .includes("duplicate")
  ) {
    console.warn("[wechat-webhook] message insert failed:", msgErr.message);
  }

  if (text.trim()) {
    try {
      await runWeChatChatbot(admin, account, { conversationId, contactId, openId, text });
    } catch (err) {
      console.error("[wechat-webhook] chatbot failed:", (err as Error).message);
    }
  }
  return true;
}

async function runWeChatChatbot(
  admin: Admin,
  account: WeChatAccountRow,
  msg: { conversationId: string; contactId: string; openId: string; text: string },
): Promise<void> {
  const { dispatchChannelBot } = await import("@/lib/chatbots/channel-dispatch.server");
  const result = await dispatchChannelBot({
    admin,
    channel: "wechat",
    workspaceId: account.workspace_id,
    accountId: account.id,
    externalId: msg.openId,
    userText: msg.text,
    conversationId: msg.conversationId,
    contactId: msg.contactId,
    sessionMetadata: { wechat_account_id: account.id, app_id: account.app_id },
  });
  if (!result?.reply) return;

  const { sendWeChatMessage } = await import("./send.server");
  await sendWeChatMessage({
    accountId: account.id,
    toUser: msg.openId,
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
      from_address: account.app_id,
      to_address: msg.openId,
      metadata: { source: "chatbot", chatbot_id: result.botId },
    });
}

async function resolveWeChatContact(
  admin: Admin,
  account: WeChatAccountRow,
  openId: string,
): Promise<string> {
  const workspaceId = account.workspace_id;
  const { data: existingIdRaw } = await admin
    .from("channel_identities")
    .select("id, contact_id")
    .eq("workspace_id", workspaceId)
    .eq("channel", "wechat")
    .eq("external_id", openId)
    .maybeSingle();
  const existingId = existingIdRaw as { id: string; contact_id: string | null } | null;

  if (existingId?.contact_id) {
    await admin
      .from("channel_identities")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existingId.id);
    return existingId.contact_id;
  }

  // Only verified Official Accounts may read profiles; an unverified one just
  // gets a placeholder name.
  let displayName: string | null = null;
  let avatarUrl: string | null = null;
  try {
    const { getWeChatUserInfo } = await import("./send.server");
    const info = await getWeChatUserInfo(account.id, openId);
    displayName = info?.nickname ?? null;
    avatarUrl = info?.headimgurl ?? null;
  } catch {
    /* a nameless contact is better than a dropped message */
  }

  const { data: contactRaw, error: cErr } = await admin
    .from("contacts")
    .insert({
      workspace_id: workspaceId,
      name: displayName ?? `WeChat user ${openId.slice(-6)}`,
      display_name: displayName,
      avatar_url: avatarUrl,
      source: "wechat",
    })
    .select("id")
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  const contactId = (contactRaw as { id: string }).id;

  const identity = {
    workspace_id: workspaceId,
    contact_id: contactId,
    channel: "wechat",
    external_id: openId,
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
