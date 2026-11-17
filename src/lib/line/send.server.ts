/**
 * LINE Messaging API helpers — server-only.
 *
 * The workspace brings its own channel access token from the LINE Developers
 * Console, so LINE is called directly (api.line.me); no gateway hop.
 *
 * Things that differ from the other bot APIs and bite if forgotten:
 *   - Two secrets, not one: the *channel secret* verifies inbound webhook
 *     signatures, the *channel access token* authorises outbound calls.
 *   - Replying with the event's `replyToken` is free and allowed once, within
 *     about a minute; `push` is billed per message. We reply when a token is
 *     at hand and fall back to push otherwise.
 *   - LINE cannot *send* arbitrary files — image/video/audio only. A document
 *     goes out as a link instead of silently disappearing.
 */
import { decryptToken } from "@/lib/instagram/token-crypto.server";

const API = "https://api.line.me";

export type LineMessage = Record<string, unknown>;

export class LineApiError extends Error {
  readonly status: number;
  readonly isAuthError: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LineApiError";
    this.status = status;
    this.isAuthError = status === 401 || status === 403;
  }
}

async function lineFetch<T>(
  accessToken: string,
  path: string,
  init: { method: "GET" | "POST" | "PUT"; body?: unknown },
): Promise<T> {
  const resp = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await resp.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!resp.ok) {
    const detail = Array.isArray(json.details)
      ? ` (${json.details.map((d) => JSON.stringify(d)).join(", ")})`
      : "";
    throw new LineApiError(
      `${String(json.message ?? `LINE ${path} failed`)}${detail}`,
      resp.status,
    );
  }
  return json as T;
}

export interface LineBotInfo {
  userId: string;
  basicId?: string;
  displayName?: string;
  pictureUrl?: string;
  chatMode?: string;
}

/** `/v2/bot/info` doubles as the access-token check. */
export async function getLineBotInfo(accessToken: string): Promise<LineBotInfo> {
  return lineFetch<LineBotInfo>(accessToken, "/v2/bot/info", { method: "GET" });
}

export interface LineProfile {
  userId: string;
  displayName?: string;
  pictureUrl?: string;
}

export async function getLineProfile(
  accessToken: string,
  userId: string,
): Promise<LineProfile | null> {
  try {
    return await lineFetch<LineProfile>(
      accessToken,
      `/v2/bot/profile/${encodeURIComponent(userId)}`,
      { method: "GET" },
    );
  } catch {
    // A user who has blocked the account has no readable profile; the message
    // itself still belongs in the inbox.
    return null;
  }
}

/** Point the channel's webhook at this deployment. */
export async function setLineWebhookEndpoint(accessToken: string, endpoint: string): Promise<void> {
  await lineFetch(accessToken, "/v2/bot/channel/webhook/endpoint", {
    method: "PUT",
    body: { endpoint },
  });
}

export async function getLineWebhookEndpoint(
  accessToken: string,
): Promise<{ endpoint: string | null; active: boolean }> {
  const res = await lineFetch<{ endpoint?: string; active?: boolean }>(
    accessToken,
    "/v2/bot/channel/webhook/endpoint",
    { method: "GET" },
  );
  return { endpoint: res.endpoint ?? null, active: res.active ?? false };
}

export interface LineSendInput {
  accessTokenCipher: string;
  /** LINE user id (`source.userId`), used for push sends. */
  to: string;
  /** Free, single-use, ~1 minute lifetime. Preferred when present. */
  replyToken?: string | null;
  text?: string | null;
  media?: {
    url: string;
    kind: "image" | "video" | "audio";
    previewUrl?: string | null;
    durationMs?: number | null;
  } | null;
  /** Rendered as a link — LINE has no outbound file message type. */
  documentUrl?: string | null;
}

export interface LineSendResult {
  /** LINE returns ids only for push/reply responses that opt in; may be empty. */
  messageId: string;
}

export function buildLineMessages(input: LineSendInput): LineMessage[] {
  const messages: LineMessage[] = [];
  const text = input.text?.trim();

  if (input.media) {
    if (input.media.kind === "image") {
      messages.push({
        type: "image",
        originalContentUrl: input.media.url,
        previewImageUrl: input.media.previewUrl || input.media.url,
      });
    } else if (input.media.kind === "video") {
      messages.push({
        type: "video",
        originalContentUrl: input.media.url,
        previewImageUrl: input.media.previewUrl || input.media.url,
      });
    } else {
      messages.push({
        type: "audio",
        originalContentUrl: input.media.url,
        // LINE requires a duration; a nominal value beats a rejected send.
        duration: input.media.durationMs && input.media.durationMs > 0 ? input.media.durationMs : 1000,
      });
    }
  }

  if (input.documentUrl) {
    messages.push({ type: "text", text: `${text ? `${text}\n` : ""}${input.documentUrl}` });
  } else if (text) {
    messages.push({ type: "text", text });
  }

  return messages;
}

export async function sendLineMessage(input: LineSendInput): Promise<LineSendResult> {
  const accessToken = decryptToken(input.accessTokenCipher);
  const messages = buildLineMessages(input);
  if (messages.length === 0) throw new Error("Message must have text or media");
  // LINE caps a single reply/push at five message objects.
  const payload = messages.slice(0, 5);

  if (input.replyToken) {
    try {
      const res = await lineFetch<{ sentMessages?: Array<{ id?: string }> }>(
        accessToken,
        "/v2/bot/message/reply",
        { method: "POST", body: { replyToken: input.replyToken, messages: payload } },
      );
      return { messageId: res.sentMessages?.[0]?.id ?? "" };
    } catch (err) {
      // An expired or already-used reply token is recoverable: push instead.
      if (!(err instanceof LineApiError) || err.status !== 400) throw err;
    }
  }

  const res = await lineFetch<{ sentMessages?: Array<{ id?: string }> }>(
    accessToken,
    "/v2/bot/message/push",
    { method: "POST", body: { to: input.to, messages: payload } },
  );
  return { messageId: res.sentMessages?.[0]?.id ?? "" };
}
