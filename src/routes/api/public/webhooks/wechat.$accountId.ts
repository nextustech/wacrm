/**
 * Public WeChat Official Account webhook endpoint — one URL per account.
 *
 *   GET  /api/public/webhooks/wechat/$accountId  → console URL validation
 *   POST /api/public/webhooks/wechat/$accountId  → inbound XML events
 *
 * Security: both verbs carry `signature`, `timestamp` and `nonce`; the
 * handler recomputes sha1 over the sorted triple with the Token stored on
 * `wechat_accounts`.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/wechat/$accountId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { handleWeChatVerification } = await import("@/lib/wechat/webhook.server");
        return await handleWeChatVerification(params.accountId, request);
      },
      POST: async ({ request, params }) => {
        const rawBody = await request.text();
        const { handleWeChatWebhook } = await import("@/lib/wechat/webhook.server");
        return await handleWeChatWebhook(params.accountId, request, rawBody);
      },
    },
  },
});
