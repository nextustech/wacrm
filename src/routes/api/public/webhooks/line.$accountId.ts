/**
 * Public LINE webhook endpoint — one URL per connected Official Account.
 *
 *   POST /api/public/webhooks/line/$accountId
 *
 * Security: LINE signs the raw body with the channel secret and sends the
 * base64 HMAC-SHA256 in `X-Line-Signature`; the handler recomputes it from
 * the secret stored on `line_accounts`.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/line/$accountId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const rawBody = await request.text();
        const { handleLineWebhook } = await import("@/lib/line/webhook.server");
        return await handleLineWebhook(params.accountId, request, rawBody);
      },
    },
  },
});
