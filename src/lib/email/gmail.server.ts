/**
 * Gmail REST wrappers for the inbox channel (server-only).
 *
 * Pure functions over a caller-supplied access token — token acquisition and
 * refresh-token storage live in gmail-sync.server.ts / accounts.functions.ts.
 * Scopes are intentionally minimal (userinfo.email, gmail.readonly, gmail.send)
 * — see GMAIL_CHANNEL_SCOPES in @/lib/integrations/google-oauth.server.
 */
import { splitEmailReply } from "./quoted-text";
import { richestBody, describeBodyChoice } from "./plain-text";
import { formatFrom, replySubject } from "./send.server";

const GMAIL_API = "https://www.googleapis.com/gmail/v1";
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export class GmailHistoryExpiredError extends Error {
  constructor() {
    super("Gmail history cursor expired (404) — needs re-seeding from the current profile.");
  }
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
  contentId: string | null;
}

export interface ParsedGmailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName: string | null;
  to: string | null;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  /** The quoted thread that was cut off `text`, kept so nothing is lost. */
  quotedText: string | null;
  /** Lowercased header map, for the caller to run its own automated-mail check with the real own-address. */
  headers: Record<string, string>;
  attachments: GmailAttachmentRef[];
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(`${GMAIL_API}${path}`, { ...init, headers });
}

export async function fetchGmailProfile(
  accessToken: string,
): Promise<{ emailAddress: string; historyId: string }> {
  const resp = await gmailFetch(accessToken, "/users/me/profile");
  if (!resp.ok) throw new Error(`Gmail profile lookup failed (${resp.status})`);
  const json = (await resp.json()) as { emailAddress?: string; historyId?: string };
  if (!json.emailAddress || !json.historyId)
    throw new Error("Gmail profile response missing fields");
  return { emailAddress: json.emailAddress, historyId: json.historyId };
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const hit = headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return hit?.value?.trim() || null;
}

/** "Ann <ann@x.com>" -> { email, name } */
function parseAddress(raw: string): { email: string; name: string | null } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : raw).trim().toLowerCase();
  const name = m ? m[1].trim() || null : null;
  return { email, name };
}

/** Depth-first search for the first body part of a given MIME type, and all attachment parts. */
function walkParts(
  part: GmailPart,
  wantMimeType: string,
  attachments: GmailAttachmentRef[],
): string | null {
  if (part.filename && part.body?.attachmentId) {
    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType || "application/octet-stream",
      attachmentId: part.body.attachmentId,
      size: part.body.size ?? 0,
      contentId: headerValue(part.headers, "Content-ID")?.replace(/^<|>$/g, "") ?? null,
    });
  }
  let found: string | null = null;
  if (!part.filename && part.mimeType === wantMimeType && part.body?.data) {
    found = decodeBase64Url(part.body.data).toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const childFound = walkParts(child, wantMimeType, attachments);
    if (!found && childFound) found = childFound;
  }
  return found;
}

export async function fetchGmailMessage(
  accessToken: string,
  id: string,
): Promise<ParsedGmailMessage> {
  const resp = await gmailFetch(
    accessToken,
    `/users/me/messages/${encodeURIComponent(id)}?format=full`,
  );
  if (!resp.ok) throw new Error(`Gmail message fetch failed (${resp.status})`);
  const json = (await resp.json()) as { id: string; threadId: string; payload?: GmailPart };
  const payload = json.payload ?? {};
  const headers = payload.headers ?? [];

  const fromRaw = headerValue(headers, "From") ?? "";
  const { email: from, name: fromName } = parseAddress(fromRaw);
  const toRaw = headerValue(headers, "To");

  const attachments: GmailAttachmentRef[] = [];
  const plainPart = walkParts(payload, "text/plain", attachments);
  const htmlPart = walkParts(payload, "text/html", attachments);
  // A stub text/plain part (template boilerplate without the code or the
  // button target) loses to the HTML the human was meant to read.
  let text: string | null = richestBody(plainPart ?? "", htmlPart ?? "");
  // TEMPORARY diagnostic (sizes and flags only, no message content) while we
  // chase verification codes that never reach the thread.
  console.warn("[email-body] gmail", JSON.stringify(describeBodyChoice(plainPart ?? "", htmlPart ?? "")));
  text = (text ?? "").trim().slice(0, 20_000);
  // Gmail hands back the whole thread; keep only what was typed this time so
  // the Inbox bubble, the preview, and the chatbot all see the actual reply.
  const { reply, quoted } = splitEmailReply(text);

  const headerRecord: Record<string, string> = {};
  for (const h of headers) if (h.name) headerRecord[h.name.toLowerCase()] = h.value ?? "";

  return {
    id: json.id,
    threadId: json.threadId,
    from,
    fromName,
    to: toRaw ? parseAddress(toRaw).email : null,
    subject: (headerValue(headers, "Subject") ?? "").trim().slice(0, 300),
    text: reply,
    quotedText: quoted,
    messageId: headerValue(headers, "Message-ID"),
    inReplyTo: headerValue(headers, "In-Reply-To"),
    references: headerValue(headers, "References"),
    headers: headerRecord,
    attachments: attachments.slice(0, 10),
  };
}

export async function fetchGmailAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  const resp = await gmailFetch(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (!resp.ok) return null;
  const json = (await resp.json()) as { data?: string; size?: number };
  if (!json.data) return null;
  const bytes = decodeBase64Url(json.data);
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) return null;
  return bytes;
}

export async function listNewGmailMessageIds(
  accessToken: string,
  sinceHistoryId: string,
): Promise<{ messageIds: string[]; newHistoryId: string | null }> {
  const ids = new Set<string>();
  let newHistoryId: string | null = null;
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      startHistoryId: sinceHistoryId,
      historyTypes: "messageAdded",
      labelId: "INBOX",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const resp = await gmailFetch(accessToken, `/users/me/history?${params}`);
    if (resp.status === 404) throw new GmailHistoryExpiredError();
    if (!resp.ok) throw new Error(`Gmail history.list failed (${resp.status})`);
    const json = (await resp.json()) as {
      history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
      historyId?: string;
      nextPageToken?: string;
    };
    for (const entry of json.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }
    if (json.historyId) newHistoryId = json.historyId;
    pageToken = json.nextPageToken;
  } while (pageToken);

  return { messageIds: [...ids], newHistoryId };
}

export interface SendGmailEmailInput {
  accessToken: string;
  fromEmail: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string | null;
  /** Reuse the Gmail thread when replying, so Gmail's own UI stays grouped too. */
  threadId?: string | null;
}

export async function sendGmailEmail(
  input: SendGmailEmailInput,
): Promise<{ messageId: string; threadId: string }> {
  const lines = [
    `From: ${formatFrom(input.fromEmail, input.fromName)}`,
    `To: ${input.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
  ];
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) lines.push(`References: ${input.references}`);
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.text).toString("base64"),
  );
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");

  const resp = await gmailFetch(input.accessToken, "/users/me/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }),
  });
  if (!resp.ok) throw new Error(`Gmail send failed (${resp.status})`);
  const json = (await resp.json()) as { id?: string; threadId?: string };
  if (!json.id || !json.threadId) throw new Error("Gmail send response missing id/threadId");
  return { messageId: json.id, threadId: json.threadId };
}

export { replySubject };

/** Best-effort — Google returns 200 even on an already-invalid token, so a failure here is not fatal. */
export async function revokeGmailToken(refreshToken: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    /* best-effort */
  }
}
