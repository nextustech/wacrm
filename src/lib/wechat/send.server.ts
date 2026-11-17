/**
 * WeChat Official Account API helpers — server-only.
 *
 * Three things make WeChat unlike the other bot channels:
 *   1. Calls authenticate with a short-lived `access_token` derived from
 *      AppID + AppSecret. WeChat rate-limits that endpoint hard (and issuing
 *      a new token invalidates the old one), so the token is cached on the
 *      account row and only refreshed when it is close to expiry.
 *   2. Failures come back as HTTP 200 with a non-zero `errcode`.
 *   3. Outbound "customer service" messages are only allowed within 48 hours
 *      of the user's last interaction; outside that window WeChat answers
 *      with errcode 45015 and the message must be a template instead.
 */
import { decryptToken, encryptToken } from "@/lib/instagram/token-crypto.server";

const API = "https://api.weixin.qq.com";

/** Refresh this long before the stated expiry, so an in-flight call cannot race it. */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

export class WeChatApiError extends Error {
  readonly errcode: number;
  readonly isAuthError: boolean;
  /** 45015: the 48-hour customer-service window has closed. */
  readonly isWindowClosed: boolean;
  constructor(message: string, errcode: number) {
    super(message);
    this.name = "WeChatApiError";
    this.errcode = errcode;
    this.isAuthError = [40001, 40013, 40014, 41001, 42001, 40125].includes(errcode);
    this.isWindowClosed = errcode === 45015;
  }
}

async function wechatFetch<T>(
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<T> {
  const resp = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    ...(init
      ? {
          // WeChat expects UTF-8 JSON; `JSON.stringify` escapes non-ASCII,
          // which WeChat accepts and keeps the body ASCII-safe.
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(init.body),
        }
      : {}),
  });
  const json = (await resp.json().catch(() => ({}))) as {
    errcode?: number;
    errmsg?: string;
  } & Record<string, unknown>;
  if (!resp.ok) {
    throw new WeChatApiError(`WeChat ${path} failed with HTTP ${resp.status}`, resp.status);
  }
  if (typeof json.errcode === "number" && json.errcode !== 0) {
    throw new WeChatApiError(
      `${json.errmsg ?? "WeChat call failed"} (errcode ${json.errcode})`,
      json.errcode,
    );
  }
  return json as T;
}

export interface WeChatTokenResult {
  accessToken: string;
  expiresAt: Date;
}

/** Exchange AppID + AppSecret for an access token. Also the credential check. */
export async function fetchWeChatAccessToken(
  appId: string,
  appSecret: string,
): Promise<WeChatTokenResult> {
  const res = await wechatFetch<{ access_token?: string; expires_in?: number }>(
    `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`,
  );
  if (!res.access_token) throw new WeChatApiError("WeChat returned no access token", -1);
  const ttl = (res.expires_in ?? 7200) * 1000;
  return { accessToken: res.access_token, expiresAt: new Date(Date.now() + ttl) };
}

interface TokenCacheRow {
  id: string;
  app_id: string;
  app_secret_ciphertext: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: string | null;
}

/**
 * The cached token for an account, refreshed (and written back) when missing
 * or near expiry.
 */
export async function getWeChatAccessToken(accountId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data } = await supabaseAdmin
    .from("wechat_accounts" as never)
    .select("id, app_id, app_secret_ciphertext, access_token_ciphertext, access_token_expires_at")
    .eq("id", accountId)
    .maybeSingle();
  const row = data as unknown as TokenCacheRow | null;
  if (!row) throw new WeChatApiError("WeChat account not found", -1);

  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token_ciphertext && expiresAt - TOKEN_SKEW_MS > Date.now()) {
    return decryptToken(row.access_token_ciphertext);
  }

  const fresh = await fetchWeChatAccessToken(row.app_id, decryptToken(row.app_secret_ciphertext));
  await supabaseAdmin
    .from("wechat_accounts" as never)
    .update({
      access_token_ciphertext: encryptToken(fresh.accessToken),
      access_token_expires_at: fresh.expiresAt.toISOString(),
    } as never)
    .eq("id", accountId);
  return fresh.accessToken;
}

export interface WeChatSendInput {
  accountId: string;
  /** The user's OpenID for this Official Account. */
  toUser: string;
  text?: string | null;
  media?: { mediaId: string; kind: "image" | "voice" | "video" } | null;
}

export interface WeChatSendResult {
  /** WeChat's custom-send returns no message id; the caller keeps its own. */
  messageId: string;
}

export async function sendWeChatMessage(input: WeChatSendInput): Promise<WeChatSendResult> {
  const accessToken = await getWeChatAccessToken(input.accountId);
  const path = `/cgi-bin/message/custom/send?access_token=${encodeURIComponent(accessToken)}`;

  if (input.media) {
    await wechatFetch(path, {
      method: "POST",
      body: {
        touser: input.toUser,
        msgtype: input.media.kind,
        [input.media.kind]: { media_id: input.media.mediaId },
      },
    });
  }

  const text = input.text?.trim();
  if (text) {
    await wechatFetch(path, {
      method: "POST",
      body: { touser: input.toUser, msgtype: "text", text: { content: text } },
    });
  }

  if (!input.media && !text) throw new Error("Message must have text or media");
  return { messageId: "" };
}

export interface WeChatUserInfo {
  openid: string;
  nickname?: string;
  headimgurl?: string;
}

/**
 * Profile lookup. Only a *verified* Official Account may call this, so a
 * failure here is expected on unverified accounts and must not break ingest.
 */
export async function getWeChatUserInfo(
  accountId: string,
  openId: string,
): Promise<WeChatUserInfo | null> {
  try {
    const accessToken = await getWeChatAccessToken(accountId);
    return await wechatFetch<WeChatUserInfo>(
      `/cgi-bin/user/info?access_token=${encodeURIComponent(accessToken)}&openid=${encodeURIComponent(openId)}&lang=en`,
    );
  } catch {
    return null;
  }
}
