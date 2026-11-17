/**
 * Attachment analysis for the AI Reply Assistant.
 *
 * The reply prompt is text. Rather than attach image and PDF bytes to every
 * reply call, each attachment is described ONCE by a vision-capable model and
 * the description is cached on the message row. Every later reply, rewrite and
 * regenerate for that conversation then reads the cached text for free.
 *
 * Why that way round, rather than attaching the file to each reply call:
 *
 *  - Cost. An image is roughly 1,100-1,600 prompt tokens and a PDF page more
 *    again. A reply gets regenerated, shortened, made friendlier, translated;
 *    inline media would be re-billed on each of those. Analysing once turns an
 *    unbounded per-reply cost into a fixed per-attachment one.
 *  - Latency. The reply itself streams (/api/ai/reply-stream). Uploading
 *    megabytes of base64 on every reply action would undo the streaming work;
 *    the cached description costs nothing to include.
 *  - Portability. The description is plain text, so a workspace whose provider
 *    has no vision support still benefits — only the one-off analysis call
 *    needs a capable provider.
 *  - Auditability. The agent can see what the AI took the file to contain,
 *    because it is stored rather than thrown away.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AIContentPart, AIMessage, AIProviderKind, ChatRequest } from "./types";
import {
  bytesToBase64,
  EXTRACTABLE_DOC_MIME,
  SUPPORTED_DOC_MIME,
  SUPPORTED_IMAGE_MIME,
} from "./content";
import { extractDocumentText } from "./doc-extract.server";
import { runChat, resolveDefaultModel, resolveDefaultProviderKind } from "./complete.functions";
import { sbAny } from "@/lib/supabase/untyped";

/**
 * Bumped when the analysis prompt changes materially, so descriptions written
 * by an older prompt are regenerated instead of being trusted forever.
 */
const ANALYSIS_VERSION = 1;

/** The `messages.metadata` key the cached description lives under. */
const META_KEY = "ai_media";

/**
 * How many attachments one reply will pay to analyse. A customer who dumps
 * twelve screenshots should not trigger twelve model calls; in practice the
 * most recent few are what the pending question is about.
 */
const MAX_PER_REPLY = 3;

/**
 * Bytes we are willing to read out of storage and base64 into a prompt. Beyond
 * this the upload dominates the latency the streaming work just recovered, and
 * providers reject oversized inline data anyway.
 */
const MAX_BYTES = 5 * 1024 * 1024;

/** Output cap for one description. Enough to list a document's key figures. */
const ANALYSIS_MAX_TOKENS = 600;

export interface MediaAnalysis {
  v: number;
  summary: string;
  model: string;
  at: string;
}

export interface AnalyzableMessage {
  id: string;
  message_type: string;
  media_type: string | null;
  media_size: number | null;
  metadata: unknown;
}

/**
 * What each provider kind can actually be handed.
 *
 * "lovable" is a legacy database value that resolves to the Gemini adapter
 * (see registry.server.ts), so it gets Gemini's abilities. OpenAI and
 * OpenRouter take images but have no PDF part in chat-completions. Everything
 * else — DeepSeek, Grok, Ollama, LM Studio, custom endpoints — is treated as
 * text-only, because a wrong guess here means a failed request rather than a
 * merely degraded one.
 */
function providerMediaSupport(kind: AIProviderKind | null): { image: boolean; pdf: boolean } {
  switch (kind) {
    case "anthropic":
    case "gemini":
    case "lovable":
      return { image: true, pdf: true };
    case "openai":
    case "openrouter":
      return { image: true, pdf: false };
    default:
      return { image: false, pdf: false };
  }
}

/** The MIME type to send: the stored one where usable, else inferred. */
function resolveMime(m: AnalyzableMessage): string | null {
  const stored = (m.media_type ?? "").toLowerCase().split(";")[0].trim();
  if (
    stored &&
    (SUPPORTED_IMAGE_MIME.has(stored) ||
      SUPPORTED_DOC_MIME.has(stored) ||
      EXTRACTABLE_DOC_MIME.has(stored))
  )
    return stored;
  // WhatsApp sometimes stores "image" or nothing at all, so fall back to the
  // stored filename's extension and finally to the message type.
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.media_name === "string" ? meta.media_name.toLowerCase() : "";
  if (/\.pdf$/.test(name)) return "application/pdf";
  if (/\.png$/.test(name)) return "image/png";
  if (/\.jpe?g$/.test(name)) return "image/jpeg";
  if (/\.webp$/.test(name)) return "image/webp";
  if (/\.gif$/.test(name)) return "image/gif";
  if (/\.docx$/.test(name))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.xlsx$/.test(name))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.csv$/.test(name)) return "text/csv";
  if (/\.tsv$/.test(name)) return "text/tab-separated-values";
  if (/\.(txt|log)$/.test(name)) return "text/plain";
  if (/\.(md|markdown)$/.test(name)) return "text/markdown";
  if (/\.json$/.test(name)) return "application/json";
  if (m.message_type === "image") return "image/jpeg";
  return null;
}

/** How a given MIME type reaches the model. */
type Route = "image" | "pdf" | "extract";

function routeFor(mime: string): Route | null {
  if (SUPPORTED_IMAGE_MIME.has(mime)) return "image";
  if (SUPPORTED_DOC_MIME.has(mime)) return "pdf";
  if (EXTRACTABLE_DOC_MIME.has(mime)) return "extract";
  return null;
}

/** The stored description, if it was written by the current prompt version. */
export function cachedAnalysis(metadata: unknown): string | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const a = meta[META_KEY] as MediaAnalysis | undefined;
  if (!a || typeof a !== "object") return null;
  if (a.v !== ANALYSIS_VERSION) return null;
  const s = typeof a.summary === "string" ? a.summary.trim() : "";
  return s || null;
}

/**
 * Where to read the bytes from, or null when there is nothing readable. A
 * provider-hosted `media_url` is deliberately not followed: those URLs expire,
 * usually need the provider's own auth, and the bytes were copied into our own
 * private bucket at ingest anyway.
 */
function storagePath(metadata: unknown): string | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return typeof meta.media_path === "string" && meta.media_path ? meta.media_path : null;
}

const ANALYSIS_SYSTEM = [
  "You are describing a file a customer sent to a support agent, so that the agent's AI assistant can answer them without seeing it.",
  "Write a dense factual description. No preamble, no commentary on image quality, and nothing about your own limitations.",
  "Extract everything an agent would need in order to reply: any question or request visible in it; all text, verbatim where short; order, invoice, tracking, reference and account numbers; amounts, currencies, totals and dates; product names, models, quantities and specifications; error messages and status text; names, addresses, phone numbers and email addresses; and the condition of anything shown as damaged, wrong, missing or incomplete.",
  "For a screenshot of a conversation or an app, say what is on screen and quote the lines that matter.",
  "For a document, invoice, receipt or form, list its fields and their values.",
  "For a photo of a product or a problem, say what the item is and what is visibly wrong with it.",
  "Never invent a detail that is not present. If part of it is unreadable, say which part and move on.",
  "Keep it under 250 words.",
].join("\n");

/**
 * Describes the given attachments, using the cache wherever possible.
 *
 * Returns a map of message id to description. A message that cannot be read,
 * is an unsupported type, or whose analysis call fails is simply absent from
 * the map: attachment analysis is an enrichment, and a reply without it is
 * still a reply, so nothing in here throws.
 */
export async function analyzeAttachments(
  supabase: SupabaseClient<Database>,
  opts: { workspaceId: string; userId: string; messages: AnalyzableMessage[] },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!opts.messages.length) return out;

  // Cache hits cost nothing, so they are never capped.
  const needed: AnalyzableMessage[] = [];
  for (const m of opts.messages) {
    const hit = cachedAnalysis(m.metadata);
    if (hit) out.set(m.id, hit);
    else needed.push(m);
  }
  if (!needed.length) return out;

  const support = providerMediaSupport(await resolveDefaultProviderKind(opts.workspaceId));

  // Newest first: when a customer sends several files, the recent ones are the
  // ones the unanswered question is about.
  const todo = needed
    .map((m) => {
      const mime = resolveMime(m);
      return { m, mime, path: storagePath(m.metadata), route: mime ? routeFor(mime) : null };
    })
    .filter((x): x is { m: AnalyzableMessage; mime: string; path: string; route: Route } => {
      if (!x.mime || !x.path || !x.route) return false;
      if ((x.m.media_size ?? 0) > MAX_BYTES) return false;
      if (x.route === "image") return support.image;
      if (x.route === "pdf") return support.pdf;
      // "extract" needs no vision support at all: the text is pulled out here
      // and goes to the model as text, so every provider can handle it.
      return true;
    })
    .reverse()
    .slice(0, MAX_PER_REPLY);
  if (!todo.length) return out;

  const model = await resolveDefaultModel(opts.workspaceId);

  // In parallel: the calls are independent and the agent is waiting.
  const results = await Promise.all(
    todo.map(async ({ m, mime, path, route }) => {
      try {
        const { data: blob, error } = await supabase.storage.from("attachments").download(path);
        if (error || !blob) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // media_size can be null or stale, so the real length is checked too.
        if (!bytes.length || bytes.length > MAX_BYTES) return null;

        const rawName = ((m.metadata ?? {}) as Record<string, unknown>).media_name;
        const filename = typeof rawName === "string" ? rawName : null;

        // Content for the analysis call. The "extract" route is the cheap one:
        // the text comes out locally, so the call is an ordinary text call that
        // any provider can serve — no vision, no base64 upload.
        let userContent: string | AIContentPart[];
        if (route === "extract") {
          const doc = await extractDocumentText(bytes, filename);
          if (!doc) return null;
          userContent = [
            `Read this ${doc.kind === "xlsx" || doc.kind === "delimited" ? "spreadsheet" : "document"} and describe it for the agent.`,
            filename ? `Filename: ${filename}` : "",
            "",
            doc.text,
          ]
            .filter(Boolean)
            .join("\n");
        } else {
          const dataBase64 = bytesToBase64(bytes);
          const part: AIContentPart =
            route === "image"
              ? { type: "image", mimeType: mime, dataBase64 }
              : {
                  type: "document",
                  mimeType: mime,
                  dataBase64,
                  filename: filename ?? undefined,
                };
          userContent = [
            part,
            {
              type: "text",
              text:
                route === "image"
                  ? "Describe this image for the agent."
                  : "Read this document and describe it for the agent.",
            },
          ];
        }

        const aiMessages: AIMessage[] = [
          { role: "system", content: ANALYSIS_SYSTEM },
          { role: "user", content: userContent },
        ];

        const request: ChatRequest = {
          model,
          messages: aiMessages,
          // A description, not creative writing: no reason to let it vary, and
          // determinism means the cached text matches what a re-run would
          // produce, so a cache hit is never worse than a fresh call.
          temperature: 0,
          max_tokens: ANALYSIS_MAX_TOKENS,
          timeout_ms: 60_000,
        };

        const res = await runChat({
          workspaceId: opts.workspaceId,
          userId: opts.userId,
          feature: "media_analysis",
          request,
        });
        const summary = (res.content ?? "").trim();
        if (!summary) return null;
        return { id: m.id, summary, metadata: m.metadata, model: res.model || model };
      } catch {
        // One unreadable file must not fail the reply.
        return null;
      }
    }),
  );

  // The cache write has to go through the service role, not the agent's own
  // client. "messages update by sender or admin" allows a member to update
  // only rows where sent_by = auth.uid() (or where they are owner/admin), and
  // an INBOUND message has sent_by = NULL because the customer sent it. Under
  // the user client the write therefore fails for every ordinary agent — and
  // since it is fire-and-forget, it would fail silently and every single reply
  // would re-analyse the same image. That is precisely the cost this module
  // exists to avoid, so the derived description is written as the server.
  // Reading the bytes stays on the agent's client, where RLS belongs: an agent
  // who may not see the file must not get it described.
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");

  for (const r of results) {
    if (!r) continue;
    out.set(r.id, r.summary);
    // Fire-and-forget: the description is already in hand for this reply, and
    // awaiting the write would put a round trip between the analysis and the
    // model call that needs it. If the write fails, the next reply re-analyses.
    const merged = {
      ...((r.metadata ?? {}) as Record<string, unknown>),
      [META_KEY]: {
        v: ANALYSIS_VERSION,
        summary: r.summary,
        model: r.model,
        at: new Date().toISOString(),
      } satisfies MediaAnalysis,
    };
    void sbAny(supabaseAdmin)
      .from("messages" as never)
      .update({ metadata: merged } as never)
      .eq("id", r.id)
      .eq("workspace_id", opts.workspaceId)
      .then(undefined, () => {});
  }

  return out;
}
