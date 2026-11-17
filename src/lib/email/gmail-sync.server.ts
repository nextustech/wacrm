/**
 * Gmail inbox channel — polling sync (server-only).
 *
 * Runs on a 3-minute pg_cron tick (see the migration that registers
 * 'wa-gmail-channel-sync' and src/routes/api/public/hooks/gmail-sync.ts).
 * Pulls new INBOX messages since the account's stored historyId, ingests them
 * into the same omnichannel inbox tables the Resend/SMTP email channel uses,
 * and runs the same chatbot auto-reply path for parity.
 */
import { decryptToken } from "@/lib/instagram/token-crypto.server";
import { googleAccessTokenFromRefreshToken } from "@/lib/integrations/google-oauth.server";
import { ensureInboxThread } from "@/lib/inbox/thread-dedup.server";
import { sbAny } from "@/lib/supabase/untyped";
import {
  GmailHistoryExpiredError,
  fetchGmailAttachment,
  fetchGmailMessage,
  fetchGmailProfile,
  listNewGmailMessageIds,
  sendGmailEmail,
  type ParsedGmailMessage,
} from "./gmail.server";
import { isAutomatedMail, resolveContact } from "./webhook.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = any;

export interface GmailAccountRow {
  id: string;
  workspace_id: string;
  provider: string;
  display_name: string;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  status: string;
  oauth_refresh_token_ciphertext: string | null;
  gmail_history_id: string | null;
}

const MAX_BOT_INPUT = 4_000;

function messageTypeFor(mime: string): "image" | "video" | "audio" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

async function accessTokenFor(account: GmailAccountRow): Promise<string> {
  if (!account.oauth_refresh_token_ciphertext)
    throw new Error("Gmail account has no stored refresh token");
  const refreshToken = decryptToken(account.oauth_refresh_token_ciphertext);
  return googleAccessTokenFromRefreshToken(refreshToken);
}

async function ingestGmailMessage(
  admin: Admin,
  account: GmailAccountRow,
  mail: ParsedGmailMessage,
  accessToken: string,
): Promise<void> {
  const providerMessageId = `gmail:${mail.id}`;
  const { data: dupe } = await admin
    .from("messages")
    .select("id")
    .eq("workspace_id", account.workspace_id)
    .eq("provider_message_id", providerMessageId)
    .limit(1)
    .maybeSingle();
  if (dupe) return;

  const automated = isAutomatedMail({
    from: mail.from,
    ownAddress: account.from_email,
    headers: mail.headers,
  });

  const contactId = await resolveContact(admin, account.workspace_id, mail.from, mail.fromName);
  const preview = mail.subject || mail.text.slice(0, 120);
  const { conversationId } = await ensureInboxThread(admin, {
    workspaceId: account.workspace_id,
    channel: "email",
    externalConversationId: `email:${account.id}:${mail.from}`,
    accountId: account.id,
    contactId,
    inbound: true,
    preview,
    metadata: {
      source: "gmail_sync",
      from: mail.from,
      last_subject: mail.subject,
      last_message_id: mail.messageId,
      last_references: mail.references,
      gmail_thread_id: mail.threadId,
    },
  });

  const baseMeta = {
    source: "gmail_sync",
    subject: mail.subject,
    automated,
    gmail_message_id: mail.id,
    gmail_thread_id: mail.threadId,
    ...(mail.quotedText ? { quoted_text: mail.quotedText } : {}),
  };

  if (mail.text || !mail.attachments.length) {
    const { error: msgErr } = await sbAny(admin)
      .from("messages")
      .insert({
        workspace_id: account.workspace_id,
        conversation_id: conversationId,
        direction: "inbound",
        status: "delivered",
        body: mail.text || null,
        message_type: "text",
        provider_message_id: providerMessageId,
        from_address: mail.from,
        to_address: mail.to ?? account.from_email,
        metadata: baseMeta,
      });
    if (
      msgErr &&
      !String(msgErr.message ?? "")
        .toLowerCase()
        .includes("duplicate")
    ) {
      throw new Error(msgErr.message);
    }
  }

  for (const [i, att] of mail.attachments.entries()) {
    try {
      const bytes = await fetchGmailAttachment(accessToken, mail.id, att.attachmentId);
      if (!bytes) continue;
      const safe = att.filename.replace(/[^\w.-]/g, "_").slice(-120);
      const path = `${account.workspace_id}/email-media/${crypto.randomUUID()}-${safe}`;
      const up = await admin.storage
        .from("attachments")
        .upload(path, bytes, { contentType: att.mimeType, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { error: attachmentError } = await sbAny(admin)
        .from("messages")
        .insert({
          workspace_id: account.workspace_id,
          conversation_id: conversationId,
          direction: "inbound",
          status: "delivered",
          body: null,
          message_type: messageTypeFor(att.mimeType),
          media_type: att.mimeType,
          media_size: bytes.byteLength,
          provider_message_id: `${providerMessageId}#att${i}`,
          from_address: mail.from,
          to_address: mail.to ?? account.from_email,
          metadata: { ...baseMeta, media_path: path, media_name: att.filename },
        });
      if (attachmentError) throw new Error(attachmentError.message);
    } catch (err) {
      console.error("[gmail-sync] attachment failed:", (err as Error).message);
    }
  }

  if (mail.text && !automated) {
    try {
      await runGmailChatbot(admin, account, { conversationId, contactId, mail, accessToken });
    } catch (err) {
      console.error("[gmail-sync] chatbot failed:", (err as Error).message);
    }
  }
}

async function runGmailChatbot(
  admin: Admin,
  account: GmailAccountRow,
  args: {
    conversationId: string;
    contactId: string;
    mail: ParsedGmailMessage;
    accessToken: string;
  },
): Promise<void> {
  const { mail, conversationId, contactId, accessToken } = args;
  const { dispatchChannelBot } = await import("@/lib/chatbots/channel-dispatch.server");
  const result = await dispatchChannelBot({
    admin,
    channel: "email",
    workspaceId: account.workspace_id,
    accountId: account.id,
    externalId: mail.from,
    userText: [mail.subject ? `Subject: ${mail.subject}` : "", mail.text.slice(0, MAX_BOT_INPUT)]
      .filter(Boolean)
      .join("\n\n"),
    conversationId,
    contactId,
    sessionMetadata: { email_account_id: account.id },
  });
  if (!result?.reply) return;

  const { replySubject } = await import("./gmail.server");
  const subject = replySubject(mail.subject);
  const sent = await sendGmailEmail({
    accessToken,
    fromEmail: account.from_email,
    fromName: account.from_name,
    to: mail.from,
    subject,
    text: result.reply,
    inReplyTo: mail.messageId,
    references: [mail.references, mail.messageId].filter(Boolean).join(" ") || null,
    threadId: mail.threadId,
  });

  await sbAny(admin)
    .from("messages")
    .insert({
      workspace_id: account.workspace_id,
      conversation_id: conversationId,
      direction: "outbound",
      status: "sent",
      body: result.reply,
      message_type: "text",
      provider_message_id: `gmail:${sent.messageId}`,
      from_address: account.from_email,
      to_address: mail.from,
      metadata: {
        source: "chatbot",
        chatbot_id: result.botId,
        subject,
        gmail_thread_id: sent.threadId,
      },
    });
}

export interface SyncResult {
  accountId: string;
  synced: number;
  error?: string;
}

export async function syncGmailAccount(
  admin: Admin,
  account: GmailAccountRow,
): Promise<SyncResult> {
  try {
    const accessToken = await accessTokenFor(account);

    if (!account.gmail_history_id) {
      const profile = await fetchGmailProfile(accessToken);
      await admin
        .from("email_accounts")
        .update({ gmail_history_id: profile.historyId, last_synced_at: new Date().toISOString() })
        .eq("id", account.id);
      return { accountId: account.id, synced: 0 };
    }

    let messageIds: string[];
    let newHistoryId: string | null;
    try {
      const result = await listNewGmailMessageIds(accessToken, account.gmail_history_id);
      messageIds = result.messageIds;
      newHistoryId = result.newHistoryId;
    } catch (err) {
      if (err instanceof GmailHistoryExpiredError) {
        const profile = await fetchGmailProfile(accessToken);
        await admin
          .from("email_accounts")
          .update({ gmail_history_id: profile.historyId, last_synced_at: new Date().toISOString() })
          .eq("id", account.id);
        return { accountId: account.id, synced: 0, error: "history_expired_reseeded" };
      }
      throw err;
    }

    let synced = 0;
    for (const id of messageIds) {
      try {
        const mail = await fetchGmailMessage(accessToken, id);
        await ingestGmailMessage(admin, account, mail, accessToken);
        synced += 1;
      } catch (err) {
        console.error("[gmail-sync] message ingest failed:", (err as Error).message);
      }
    }

    await admin
      .from("email_accounts")
      .update({
        gmail_history_id: newHistoryId ?? account.gmail_history_id,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return { accountId: account.id, synced };
  } catch (err) {
    return { accountId: account.id, synced: 0, error: (err as Error).message };
  }
}
