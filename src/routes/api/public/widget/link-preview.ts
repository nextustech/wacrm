/**
 * Public link-preview endpoint for the chat widget. A visitor needs a real,
 * already-established session (signed `visitorToken`) to call this — it
 * isn't an open "fetch any URL" endpoint; combined with the domain allowlist
 * in `allowlist.ts`, that keeps it from being usable as a public SSRF probe.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { verifyVisitor, checkWidgetRate } from "@/lib/widget/widget-runtime.server";
import { getOrFetchLinkPreview } from "@/lib/link-preview/link-preview.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const BodySchema = z.object({
  sessionId: z.string().uuid(),
  visitorToken: z.string().min(10).max(200),
  url: z.string().min(1).max(2000),
});

export const Route = createFileRoute("/api/public/widget/link-preview")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      POST: async ({ request }) => {
        const ip =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
          "unknown";
        // Generous but bounded — a message can only carry a handful of
        // links, and results are cached, so legitimate traffic never gets
        // near this.
        if (!checkWidgetRate(`link-preview:${ip}`, 60)) {
          return json(429, { error: "Too many requests" });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON" });
        }
        const parsed = BodySchema.safeParse(body);
        if (!parsed.success) return json(400, { error: "Invalid input" });

        const { sessionId, visitorToken, url } = parsed.data;
        if (!verifyVisitor(sessionId, visitorToken)) return json(401, { error: "Invalid session" });

        const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
        const result = await getOrFetchLinkPreview(supabaseAdmin, url);
        return json(200, result);
      },
    },
  },
});
