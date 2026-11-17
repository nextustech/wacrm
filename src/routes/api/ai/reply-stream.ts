/**
 * AI Reply Assistant — streaming endpoint.
 *
 * POST /api/ai/reply-stream
 * Body: the same payload the `aiReplyAssistant` server function takes.
 * Auth: Bearer <supabase-access-token> in the Authorization header.
 *
 * Why this exists: generating a reply takes as long as it takes, but the
 * non-streaming path made the agent wait for the *entire* answer before
 * showing a single character — tens of seconds of blank panel. Here the text
 * arrives as the model produces it, so the wait before something appears is
 * roughly one round trip.
 *
 * Wire format is SSE, one JSON object per event:
 *   {"t":"delta","v":"partial text"}
 *   {"t":"done","model":"…","providerKind":"…","tokens":123}
 *   {"t":"error","message":"human-readable reason"}
 */
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { runChatStream } from "@/lib/ai/complete.functions";
import { buildReplyRequest, describeProviderFailure } from "@/lib/ai/reply-assistant.functions";
import { AIError } from "@/lib/ai/errors";
import { PROVIDER_CREDITS_MESSAGE } from "@/lib/ai/reply-error";
import type { Database } from "@/integrations/supabase/types";

const BodySchema = z.object({
  conversationId: z.string().uuid(),
  action: z.enum([
    "generate",
    "tone_professional",
    "tone_friendly",
    "tone_formal",
    "tone_casual",
    "shorten",
    "expand",
    "rewrite",
    "grammar",
    "improve",
    "translate",
    "continue",
    "custom",
  ]),
  draft: z.string().optional().default(""),
  customPrompt: z.string().optional(),
  targetLanguage: z.string().optional(),
  regenerate: z.boolean().optional().default(false),
});

/** Turns any thrown value into the message the agent should actually read. */
function explain(error: unknown): string {
  if (error instanceof AIError) {
    if (error.type === "billing") return PROVIDER_CREDITS_MESSAGE;
    console.error("[ai.reply_stream] provider call failed", {
      type: error.type,
      httpStatus: error.httpStatus,
      provider: error.providerKind,
      body: error.message.slice(0, 500),
    });
    return describeProviderFailure(error);
  }
  return error instanceof Error ? error.message : "AI reply could not be generated.";
}

export const Route = createFileRoute("/api/ai/reply-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authHeader = request.headers.get("authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const token = authHeader.slice("Bearer ".length);

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!supabaseUrl || !supabaseKey) {
          return new Response("Server misconfigured", { status: 500 });
        }

        // Same client shape as the auth middleware: the caller's token does
        // the talking, so RLS applies exactly as it does everywhere else.
        // Matches the auth middleware and /api/ai/conversation-stream: the
        // newer "sb_" publishable keys must not be sent as a Bearer token.
        const isNewKey = supabaseKey.startsWith("sb_");
        const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) => {
              const headers = new Headers(init?.headers);
              if (isNewKey && headers.get("Authorization") === `Bearer ${supabaseKey}`) {
                headers.delete("Authorization");
              }
              headers.set("apikey", supabaseKey);
              headers.set("Authorization", `Bearer ${token}`);
              return fetch(input, { ...init, headers });
            },
          },
        });

        const { data: claims, error: claimsErr } = await supabase.auth.getClaims(token);
        if (claimsErr || !claims?.claims?.sub) {
          return new Response("Unauthorized", { status: 401 });
        }
        const userId = claims.claims.sub;

        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch (e) {
          return new Response(e instanceof Error ? e.message : "Bad request", { status: 400 });
        }

        // Prompt assembly can fail on its own (conversation gone, no provider
        // configured). That happens before any streaming, so report it as a
        // normal HTTP error rather than opening a stream just to close it.
        let built: Awaited<ReturnType<typeof buildReplyRequest>>;
        try {
          built = await buildReplyRequest(supabase, userId, body);
        } catch (e) {
          return new Response(explain(e), { status: 400 });
        }

        const encoder = new TextEncoder();
        const send = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const ev of runChatStream({
                workspaceId: built.workspaceId,
                userId,
                feature: "reply_assistant",
                request: built.req,
              })) {
                if (ev.type === "delta") {
                  controller.enqueue(send({ t: "delta", v: ev.text }));
                } else {
                  controller.enqueue(
                    send({
                      t: "done",
                      model: ev.model,
                      providerKind: ev.providerKind,
                      tokens: ev.usage.total_tokens,
                      finishReason: ev.finishReason,
                    }),
                  );
                }
              }
            } catch (e) {
              // The response has already been handed to the client, so the
              // only way to report this is inside the stream.
              controller.enqueue(send({ t: "error", message: explain(e) }));
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            // Without this an nginx or CDN hop buffers the whole response and
            // the streaming is invisible to the browser.
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
