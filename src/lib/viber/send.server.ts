/**
 * Viber Bot API helpers — server-only.
 *
 * Viber is called directly (chatapi.viber.com); the workspace brings its own
 * bot auth token from the Viber Admin Panel, so there is no gateway hop.
 *
 * Two things differ from most REST APIs and bite if forgotten:
 *   1. Every call is a POST, and failures come back as HTTP 200 with a
 *      non-zero `status` in the body — `callViberRaw` normalises that into a
 *      thrown {@link ViberApiError}.
 *   2. `send_message` requires a `sender.name`; Viber rejects the call
 *      without it.
 */
import { decryptToken } from "@/lib/instagram/token-crypto.server";

const API = "https://chatapi.viber.com/pa";

/** Viber truncates longer sender names, so trim before they do. */
const MAX_SENDER_NAME = 28;

export type ViberMediaKind = "picture" | "video" | "file";

export interface ViberSendInput {
  authTokenCipher: string;
  /** Viber subscriber id (`sender.id` on the inbound event). */
  receiver: string;
  senderName?: string | null;
  senderAvatar?: string | null;
  text?: string | null;
  media?: { url: string; kind: ViberMediaKind; fileName?: string | null; sizeBytes?: number | null } | null;
}

export interface ViberSendResult {
  messageToken: string;
}

export class ViberApiError extends Error {
  /** Viber's own `status` code (0 = ok). HTTP status when the call never landed. */
  readonly status: number;
  readonly isAuthError: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ViberApiError";
    this.status = status;
    // 2 = invalid auth token, 3 = bad/missing token on the request.
    this.isAuthError = status === 2 || status === 3 || status === 401 || status === 403;
  }
}

export async function callViber<T = Record<string, unknown>>(
  authTokenCipher: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  return callViberRaw<T>(decryptToken(authTokenCipher), method, body);
}

export async function callViberRaw<T = Record<string, unknown>>(
  authToken: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const resp = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Viber-Auth-Token": authToken,
    },
    body: JSON.stringify(body),
  });
  const json = (await resp.json().catch(() => ({}))) as {
    status?: number;
    status_message?: string;
  } & Record<string, unknown>;
  if (!resp.ok) {
    throw new ViberApiError(
      json.status_message ?? `Viber ${method} failed with HTTP ${resp.status}`,
      resp.status,
    );
  }
  if (json.status !== 0) {
    throw new ViberApiError(
      json.status_message ?? `Viber ${method} returned status ${json.status}`,
      typeof json.status === "number" ? json.status : -1,
    );
  }
  return json as T;
}

export interface ViberAccountInfo {
  id: string;
  name?: string;
  uri?: string;
  icon?: string;
  webhook?: string;
  event_types?: string[];
}

/** `get_account_info` doubles as the token check: a bad token never reaches status 0. */
export async function getViberAccountInfo(authToken: string): Promise<ViberAccountInfo> {
  return callViberRaw<ViberAccountInfo>(authToken, "get_account_info");
}

/** Events we want delivered. `webhook` is Viber's own validation ping. */
export const VIBER_EVENT_TYPES = [
  "delivered",
  "seen",
  "failed",
  "subscribed",
  "unsubscribed",
  "conversation_started",
] as const;

export async function setViberWebhook(authToken: string, url: string): Promise<void> {
  await callViberRaw(authToken, "set_webhook", {
    url,
    event_types: [...VIBER_EVENT_TYPES],
    send_name: true,
    send_photo: true,
  });
}

/** Viber removes the webhook when the URL is an empty string. */
export async function clearViberWebhook(authToken: string): Promise<void> {
  await callViberRaw(authToken, "set_webhook", { url: "" });
}

export async function sendViberMessage(input: ViberSendInput): Promise<ViberSendResult> {
  const token = decryptToken(input.authTokenCipher);
  const sender = {
    name: (input.senderName?.trim() || "Support").slice(0, MAX_SENDER_NAME),
    ...(input.senderAvatar ? { avatar: input.senderAvatar } : {}),
  };
  const text = input.text?.trim() || "";

  if (input.media) {
    const base: Record<string, unknown> = { receiver: input.receiver, sender };
    if (input.media.kind === "picture") {
      // A picture carries its caption in `text`; Viber has no caption field.
      Object.assign(base, { type: "picture", media: input.media.url, text });
    } else if (input.media.kind === "video") {
      // `size` is mandatory on a video. Viber rejects 0, so fall back to a
      // nominal value when the stored row has no byte count.
      Object.assign(base, {
        type: "video",
        media: input.media.url,
        size: input.media.sizeBytes && input.media.sizeBytes > 0 ? input.media.sizeBytes : 1,
        ...(text ? { text } : {}),
      });
    } else {
      Object.assign(base, {
        type: "file",
        media: input.media.url,
        size: input.media.sizeBytes && input.media.sizeBytes > 0 ? input.media.sizeBytes : 1,
        file_name: input.media.fileName || "attachment",
      });
    }
    const res = await callViberRaw<{ message_token?: number | string }>(
      token,
      "send_message",
      base,
    );
    // A file/video send drops the caption, so follow it with the text.
    if (text && input.media.kind !== "picture") {
      try {
        await callViberRaw(token, "send_message", {
          receiver: input.receiver,
          sender,
          type: "text",
          text,
        });
      } catch {
        /* the media landed; a missing caption is not worth failing the send */
      }
    }
    return { messageToken: String(res.message_token ?? "") };
  }

  if (!text) throw new Error("Message must have text or media");
  const res = await callViberRaw<{ message_token?: number | string }>(token, "send_message", {
    receiver: input.receiver,
    sender,
    type: "text",
    text,
  });
  return { messageToken: String(res.message_token ?? "") };
}
