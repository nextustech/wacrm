/**
 * Public Viber webhook endpoint — one URL per connected bot.
 *
 *   POST /api/public/webhooks/viber/$accountId
 *
 * Security: Viber signs the raw body with the bot's auth token and sends the
 * hex HMAC-SHA256 in `X-Viber-Content-Signature`; the handler recomputes it
 * from the token stored on `viber_accounts`.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/viber/$accountId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const rawBody = await request.text();
        const { handleViberWebhook } = await import("@/lib/viber/webhook.server");
        return await handleViberWebhook(params.accountId, request, rawBody);
      },
    },
  },
});
