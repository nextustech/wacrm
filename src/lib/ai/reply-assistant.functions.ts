/**
 * AI Reply Assistant — generates suggested replies, rewrites, translations,
 * and grammar fixes with full conversation + CRM context awareness.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { runChat, resolveDefaultModel } from "./complete.functions";
import { AIError } from "./errors";
import { PROVIDER_CREDITS_MESSAGE } from "./reply-error";
import type { AIMessage, ChatRequest } from "./types";
import { sbAny } from "@/lib/supabase/untyped";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { readBusinessContextValue } from "./settings.functions";
import { analyzeAttachments, type AnalyzableMessage } from "./media-analysis.server";

export type ReplyAction =
  | "generate"
  | "tone_professional"
  | "tone_friendly"
  | "tone_formal"
  | "tone_casual"
  | "shorten"
  | "expand"
  | "rewrite"
  | "grammar"
  | "improve"
  | "translate"
  | "continue"
  | "custom";

const input = z.object({
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

export type ReplyAssistantInput = z.infer<typeof input>;

/**
 * Actions that transform the agent's own draft rather than composing a new
 * reply. The distinction drives everything below: in rewrite mode the draft
 * is the agent's instruction, not a claim to be fact-checked against the
 * knowledge base, so nothing in it may be dropped.
 */
const REWRITE_ACTIONS: ReadonlySet<ReplyAction> = new Set<ReplyAction>([
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
]);

/** Mechanical text transforms that need no business context at all. */
const TEXT_ONLY_ACTIONS: ReadonlySet<ReplyAction> = new Set<ReplyAction>(["grammar", "translate"]);

function isRewriteAction(action: ReplyAction, draft: string): boolean {
  // "custom" is a rewrite when there's a draft to apply the instruction to.
  if (action === "custom") return draft.trim().length > 0;
  return REWRITE_ACTIONS.has(action);
}

function actionInstruction(
  action: ReplyAction,
  opts: { targetLanguage?: string; customPrompt?: string; hasDraft: boolean },
): string {
  switch (action) {
    case "generate":
      return [
        "Write the agent's next reply.",
        // The composer is where the agent jots down what the reply should say
        // before pressing Generate. Without this the notes arrived as an
        // unexplained DRAFT block and the model quietly ignored them.
        opts.hasDraft
          ? "The agent has typed NOTES in the composer (below, under AGENT'S NOTES). They are the agent's instruction about what this reply must say — not the reply itself, and not text to send as written. Build the reply around them: turn every point in them into proper, complete sentences, at the depth the notes imply. Nothing in the notes may be dropped, shortened away or softened, and nothing in them is a claim for you to verify. The notes may be written in a different language from the conversation — that says nothing about which language the reply is in."
          : "",
        "Address EVERY unanswered message the customer has sent since the agent last replied — not only the final one. Answer each question specifically, confirm anything they handed over or set up, and pick up each status update with the agent's corresponding next step. If any of it accepts or confirms something the agent offered, continue down that exact path and give the next step for it. End in a way that moves the sale or the support case forward.",
      ]
        .filter(Boolean)
        .join(" ");
    case "tone_professional":
      return "Rewrite the draft in a professional, polished tone — competent and respectful, not stiff.";
    case "tone_friendly":
      return "Rewrite the draft in a warm, friendly, human tone. Natural contractions are fine.";
    case "tone_formal":
      return "Rewrite the draft in a formal, courteous business tone. No contractions, no slang.";
    case "tone_casual":
      return "Rewrite the draft in a relaxed, conversational tone, the way a helpful colleague types. Natural, not slangy.";
    case "shorten":
      return "Compress the draft to at most two short sentences. Drop pleasantries and filler first — never the offer, the price, the question or the call to action.";
    case "expand":
      return "Expand the draft into a fuller reply: keep every point it already makes and add genuinely useful detail that supports it. Do not pad with generic filler.";
    case "rewrite":
      return "Rewrite the draft so it reads more naturally and clearly, keeping the same intent, the same points, and the same level of detail.";
    case "grammar":
      return "Fix only grammar, spelling and punctuation. Keep the wording, tone, structure and every word choice otherwise identical. If the draft is already correct, return it unchanged.";
    case "improve":
      return "Sharpen the draft: clearer wording, better flow, stronger phrasing. Keep every point it makes and the agent's voice.";
    case "translate":
      return `Translate the draft into ${opts.targetLanguage || "English"}. Translate faithfully — same tone, same points, same numbers. Return only the translation.`;
    case "continue":
      return "The draft stops mid-thought. Finish it naturally and return the COMPLETE message — the original opening plus your continuation, not just the new part.";
    case "custom":
      return opts.hasDraft
        ? `Apply this instruction from the agent to the draft: "${(opts.customPrompt || "").slice(0, 500)}". The instruction outranks the other rules about keeping the draft intact — if it asks you to change, remove or add something, do exactly that, and leave everything it doesn't mention untouched.`
        : `Write the agent's next reply following this instruction: "${(opts.customPrompt || "").slice(0, 500)}". Answer the customer's latest message as part of it.`;
  }
}

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  job_title: string | null;
  timezone: string | null;
  language: string | null;
  tags: string[] | null;
  notes: string | null;
  lifetime_value: number | null;
  lead_status: string | null;
  customer_status: string | null;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  channel: string | null;
  status: string | null;
  subject: string | null;
}

interface MessageContextRow {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  message_type: string;
  created_at: string;
  // Attachment columns: the reply used to select only the four fields above,
  // which is why an image or PDF could never be more than a "[image]" label in
  // the transcript however relevant its contents were.
  media_type: string | null;
  media_size: number | null;
  metadata: unknown;
}

interface WorkspaceRow {
  id: string;
  name: string | null;
  ai_business_context: string | null;
}

export interface ReplyAssistantResult {
  reply: string;
  model: string;
  providerKind: string;
  tokens: number;
  action: ReplyAction;
}

/**
 * The human-readable reason a provider call failed.
 *
 * Provider adapters put the raw HTTP body in `AIError.message` (first 500
 * chars). OpenAI-compatible APIs, Anthropic and Gemini all wrap their reason in
 * an `error.message` field, so pull that out and prefix it with what the status
 * means and who to tell. Anything we cannot parse falls back to the status.
 */
export function describeProviderFailure(error: AIError): string {
  let detail = "";
  const body = error.message ?? "";
  if (/^\s*[{[]/.test(body)) {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string } | string;
        message?: string;
      };
      const inner = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
      detail = (inner ?? parsed.message ?? "").toString();
    } catch {
      /* truncated body — not valid JSON, fall through */
    }
  } else {
    detail = body;
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 180);

  const provider = error.providerKind ? `${error.providerKind}: ` : "";
  const lead = (() => {
    switch (error.type) {
      case "auth":
        return "The AI provider rejected the API key. Update it in API Configuration → AI Settings.";
      case "not_found":
        return "The AI provider does not have the configured model. Pick another default model in AI Settings.";
      case "validation":
        return "The AI provider refused the request.";
      case "rate_limit":
        return "The AI provider is rate limiting this workspace. Try again shortly.";
      case "context_length":
        return "This conversation is too long for the configured model. Choose a model with a larger context window.";
      case "timeout":
        return "The AI provider did not answer in time, twice. Try a faster model in AI Settings, or try again later.";
      case "cancelled":
        return "The request was cancelled before the model answered — usually the page reloaded or navigated. Try again.";
      case "network":
        return "The server could not reach the AI provider. Check outbound network access.";
      case "server":
        return "The AI provider is having problems right now. Try again in a minute.";
      default:
        return "The AI provider returned an error.";
    }
  })();

  return detail
    ? `${lead} (${provider}${detail})`
    : `${lead}${error.httpStatus ? ` [HTTP ${error.httpStatus}]` : ""}`;
}

/**
 * Builds the complete chat request for a reply action: context gathering, KB
 * retrieval, prompt assembly and model selection.
 *
 * Extracted from the server function so the streaming endpoint
 * (/api/ai/reply-stream) can build exactly the same request without
 * duplicating any of it. The two paths must stay identical — a reply whose
 * wording depended on whether it streamed would be a miserable bug to chase.
 */
export async function buildReplyRequest(
  supabase: SupabaseClient<Database>,
  userId: string,
  data: ReplyAssistantInput,
): Promise<{ workspaceId: string; req: ChatRequest; baseBudget: number; action: ReplyAction }> {
    // Everything below used to run strictly one after another: roughly a
    // dozen sequential Supabase round trips before the model was even called.
    // On a Worker that is a second or more of dead time on every reply, so the
    // queries now go out in two batches — the second one depends on the
    // conversation row, nothing else does.
    //
    // 1+3. Conversation and recent messages.
    const [convRes, msgsRes] = await Promise.all([
      supabase
        .from("conversations")
        .select("id, workspace_id, contact_id, channel, status, subject")
        .eq("id", data.conversationId)
        .maybeSingle(),
      supabase
        .from("messages")
        .select(
          "id, direction, body, message_type, created_at, media_type, media_size, metadata",
        )
        .eq("conversation_id", data.conversationId)
        .order("created_at", { ascending: false })
        .limit(30),
    ]);
    if (convRes.error) throw new Error(convRes.error.message);
    if (!convRes.data) throw new Error("Conversation not found");
    const conv = convRes.data as ConversationRow;
    // A WhatsApp customer sends one thought per bubble, so 20 rows often did
    // not even reach the agent's previous reply.
    const messages = ((msgsRes.data ?? []) as unknown as MessageContextRow[]).reverse();

    // Model/provider resolution is three more round trips that have nothing to
    // do with the prompt, so it starts now and is awaited at the call site.
    // The bare .catch keeps an early rejection from being reported as an
    // unhandled rejection; the real error still surfaces where it is awaited.
    const modelPromise = resolveDefaultModel(conv.workspace_id);
    modelPromise.catch(() => {});

    // 2+4. Contact, workspace name and business context all hang off the
    // conversation row, so they go out together.
    const [contactRes, wsRes, settingsRes] = await Promise.all([
      conv.contact_id
        ? supabase
            .from("contacts")
            .select(
              "id, first_name, last_name, phone, email, company, job_title, timezone, language, tags, notes, lifetime_value, lead_status, customer_status",
            )
            .eq("id", conv.contact_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("workspaces").select("id, name").eq("id", conv.workspace_id).maybeSingle(),
      supabase
        .from("settings")
        .select("value")
        .eq("scope", "workspace")
        .eq("workspace_id", conv.workspace_id)
        .is("user_id", null)
        .eq("key", "ai_business_context")
        .limit(1)
        .maybeSingle(),
    ]);
    const contact = (contactRes.data ?? null) as ContactRow | null;
    const workspaceName = (wsRes.data as WorkspaceRow | null)?.name ?? "";
    let workspaceCtx = "";
    try {
      // settings.value is jsonb: the AI Settings page writes { text }; a plain
      // string or { value } is also accepted.
      workspaceCtx = readBusinessContextValue(
        (settingsRes.data as { value?: unknown } | null)?.value,
      ).trim();
    } catch {
      /* optional */
    }

    // 5. Build the system prompt
    const contactName = contact
      ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") ||
        contact.phone ||
        "Customer"
      : "Customer";

    const crmLines: string[] = [];
    if (contact) {
      if (contact.company) crmLines.push(`Company: ${contact.company}`);
      if (contact.job_title) crmLines.push(`Job title: ${contact.job_title}`);
      if (contact.email) crmLines.push(`Email: ${contact.email}`);
      if (contact.language) crmLines.push(`Preferred language: ${contact.language}`);
      if (contact.timezone) crmLines.push(`Timezone: ${contact.timezone}`);
      if (contact.lifetime_value) crmLines.push(`Lifetime value: ${contact.lifetime_value}`);
      if (contact.lead_status) crmLines.push(`Lead status: ${contact.lead_status}`);
      if (contact.customer_status) crmLines.push(`Customer status: ${contact.customer_status}`);
      if (contact.tags?.length) crmLines.push(`Tags: ${contact.tags.join(", ")}`);
      if (contact.notes) crmLines.push(`Internal notes: ${contact.notes.slice(0, 400)}`);
    }

    // 4a. Read the customer's image and PDF attachments.
    //
    // These used to reach the model as a bare "[image]" label, so a customer
    // who photographed a damaged product or sent an invoice PDF got a reply
    // that acknowledged "a file" and answered nothing in it. Each one is now
    // described by a vision model once and cached on the message row, so the
    // description is free on every later reply for this conversation.
    //
    // Skipped for the mechanical transforms and rewrites: those operate on the
    // agent's own draft text, where an attachment description is not just
    // useless but actively misleading — it gives the model material the draft
    // never mentioned.
    const mediaAction = data.action as ReplyAction;
    const wantsMedia =
      !TEXT_ONLY_ACTIONS.has(mediaAction) && !isRewriteAction(mediaAction, data.draft ?? "");
    let mediaSummaries = new Map<string, string>();
    if (wantsMedia) {
      // Inbound only: the agent knows what the agent sent. Capped at the last
      // six because cached descriptions are free but uncached ones are a model
      // call each — the analyser caps those again at three.
      const withMedia = messages.filter(
        (m) =>
          m.direction === "inbound" &&
          (m.message_type === "image" || m.message_type === "document"),
      );
      if (withMedia.length) {
        mediaSummaries = await analyzeAttachments(supabase, {
          workspaceId: conv.workspace_id,
          userId,
          messages: withMedia.slice(-6) as AnalyzableMessage[],
        });
      }
    }

    // Attachments carry meaning even with no caption ("here's the screenshot
    // you asked for"). Dropping them left gaps the model filled by guessing,
    // so they stay in the transcript as a labelled placeholder — now with the
    // file's contents appended wherever they could be read.
    const spoken = messages
      .map((m) => {
        const body = (m.body ?? "").trim();
        const label = m.message_type && m.message_type !== "text" ? `[${m.message_type}]` : "";
        const head = label ? (body ? `${label} ${body}` : label) : body;
        const summary = mediaSummaries.get(m.id);
        return {
          ...m,
          text: summary ? `${head}
    (contents of that file: ${summary})` : head,
        };
      })
      .filter((m) => m.text);
    const hasMediaSummaries = mediaSummaries.size > 0;

    const transcript = spoken
      .map((m) => `${m.direction === "inbound" ? contactName : "Agent"}: ${m.text}`)
      .join("\n");

    // On WhatsApp a customer types one thought per bubble, so the thing that
    // needs answering is the whole run of messages since the agent last
    // replied — not the last line. Calling out only the last line produced
    // one-sentence replies that answered the closing remark and silently
    // ignored every question, credential and status update before it.
    let lastOutboundIdx = -1;
    for (let i = spoken.length - 1; i >= 0; i--) {
      if (spoken[i].direction === "outbound") {
        lastOutboundIdx = i;
        break;
      }
    }
    const pendingInbound = spoken
      .slice(lastOutboundIdx + 1)
      .filter((m) => m.direction === "inbound");
    const pendingBlock = pendingInbound.map((m, i) => `(${i + 1}) ${m.text}`).join("\n");
    // The agent's own message the customer is replying to. Without it, "Yes, I
    // want to buy directly from you" reads as a bare purchase intent, and the
    // model answers it with the generic marketplace procedure from the
    // knowledge base instead of the direct-purchase arrangement just offered.
    const agentPriorMessage = lastOutboundIdx >= 0 ? spoken[lastOutboundIdx].text : "";

    // 4b. Retrieve grounding excerpts from the AI Knowledge Base (RAG).
    // Only when composing a reply: during a rewrite the excerpts compete with
    // the agent's own draft, and the model starts answering from the KB
    // instead of transforming what the agent wrote.
    let kbBlock = "";
    try {
      const kbQuery = isRewriteAction(data.action as ReplyAction, data.draft ?? "")
        ? ""
        : pendingBlock || (data.draft ?? "").trim() || transcript.slice(-800);
      if (kbQuery && kbQuery.trim()) {
        const { embedOne, toVectorLiteral } = await import("../kb/embed.server");
        const vec = await embedOne(kbQuery.slice(0, 2000));
        const { data: kbRows } = await sbAny(supabase).rpc(
          "match_kb_chunks" as never,
          {
            p_workspace_id: conv.workspace_id,
            p_query_embedding: toVectorLiteral(vec),
            p_match_count: 4,
            p_min_similarity: 0.28,
            p_only_published: true,
          } as never,
        );
        const hits = (kbRows ?? []) as unknown as Array<{
          title: string;
          content: string;
          article_id: string;
        }>;
        if (hits.length) {
          kbBlock = hits.map((h, i) => `[KB${i + 1}] ${h.title}\n${h.content}`).join("\n---\n");
          // fire-and-forget analytics: mark KB articles as "suggested" for this conversation.
          try {
            const seen = new Set<string>();
            const rows = hits
              .filter((h) => !seen.has(h.article_id) && seen.add(h.article_id))
              .map((h) => ({
                article_id: h.article_id,
                workspace_id: conv.workspace_id,
                event_type: "suggested",
                user_id: userId,
                conversation_id: data.conversationId,
                metadata: {} as Record<string, unknown>,
              }));
            if (rows.length) {
              // Genuinely fire-and-forget: this is analytics, and awaiting it
              // put a whole round trip between the KB lookup and the model
              // call. The .catch is what keeps it from becoming an unhandled
              // rejection now that nothing awaits it.
              void sbAny(supabase)
                .from("kb_article_events" as never)
                .insert(rows as never)
                .then(undefined, () => {});
            }
          } catch {
            /* non-fatal */
          }
        }
      }
    } catch {
      /* KB grounding is optional */
    }

    const action = data.action as ReplyAction;
    const draft = (data.draft ?? "").trim();
    const rewriteMode = isRewriteAction(action, draft);
    const textOnly = TEXT_ONLY_ACTIONS.has(action);

    // House rules, then the rules specific to the mode. The split matters:
    // "never invent facts" is right when composing a reply from scratch, but
    // applied to a rewrite it makes the model delete whatever the agent wrote
    // that it can't corroborate — which is how "we have a special offer for
    // you" silently disappeared from a tone rewrite.
    const baseRules = [
      `You are an AI reply assistant helping a support/sales agent at ${workspaceName || "the company"} respond to a customer on ${conv.channel || "chat"}.`,
      `Output ONLY the message text the agent will send. No preface, no sign-off block, no explanation of what you changed, no quotes around it, no markdown fences.`,
      `Write in the language the customer is writing in. The agent's own notes or draft may be in a different language — that is the agent talking to you, and it never changes the language of the reply.`,
    ];

    const rewriteRules = [
      `The agent wrote the DRAFT below. The agent knows this customer and this business: the draft is an instruction to you, NOT a claim for you to verify, soften or second-guess.`,
      `Carry EVERY substantive element of the draft into your output. Work it out from the draft itself rather than from a fixed list: anything the agent states, offers, promises, prices, names, links to, schedules, conditions or asks is substantive, whatever kind of thing it is — a product discount, a service offer, a free add-on, a deadline, a bundle, a payment term, a warranty, a callback, an escalation, anything else.`,
      `A useful check: if removing a phrase would change what the customer is being told, promised or asked, that phrase must survive the rewrite — only the wording around it may change.`,
      `Never drop an element because you cannot find it in the context below, and never weaken it into something vaguer ("an offer" for a stated discount, "soon" for a stated date, "some options" for named items). The context is background; the draft is the instruction.`,
      `Do not add facts, products, conditions, caveats or next steps the draft does not mention, and do not answer the conversation afresh. Transform the draft, nothing more.`,
    ];

    const generateRules = [
      `The customer usually sends several short messages in a row before the agent gets to reply. Treat that whole run as ONE message: your reply must deal with every question, request, detail and update in it, not just the last line.`,
      `Work through the unanswered messages in order and give each one its due — a question gets a real answer, something the customer provided or set up gets confirmed as received plus what happens with it next, a status update gets the agent's matching next step, a problem gets a resolution or a clear timeline. Dropping any of them is a failed reply.`,
      `Answer directly and concretely — no generic opening that could fit any conversation, and no one-line acknowledgement standing in for a reply that several open points needed.`,
      // Which rule applies depends on whether anything was actually readable:
      // promising the model it can see an attachment when the description is
      // missing is how you get a confident reply about an invoice nobody read.
      hasMediaSummaries
        ? `Attachments appear in the conversation as [image], [document] and similar, sometimes with a caption. Where a line reading "(contents of that file: ...)" follows one, that is an accurate account of what the file contains, read for you: treat it as something you have seen, use the numbers, names, text and condition it reports, and answer what the customer is asking about it directly and specifically. Do not say you are unable to view the file, do not ask them to describe it again, and do not repeat the description back at them wholesale — use it to answer. Where an attachment has NO contents line (a video, a voice note, or a file that could not be read), respond only to what the customer said about it and the fact that it arrived, and never describe it or claim to have reviewed it.`
        : `Attachments appear in the conversation as [image], [document], [audio] and similar, sometimes with a caption. The agent can see them, you cannot: respond to what the customer said about them and the fact that they were sent, and never describe their contents or claim to have reviewed them.`,
      // The agent typed those notes because they already decided what to say.
      // The rules below (especially DEFAULT TO NOT SELLING) were silently
      // deleting offers, prices and next steps the agent had asked for.
      `If AGENT'S NOTES are supplied, they outrank every other rule here. Everything they tell you to say goes into the reply — an offer, a price, a condition, a next step, a warning — even where the rules below would leave it out. Work through the notes point by point; a reply that covers only some of them has failed.`,
      `Let the length follow the content, and finish what you start. One open point is two or three sentences; several open points, or detailed agent notes, need a longer reply with a line or two for each. Never stop mid-sentence, never trail off, and never let a heading or a lead-in stand with nothing after it — every sentence you begin must be completed.`,
      `This conversation is the source of truth about what has already been agreed with this customer. Anything the agent has already said, offered, promised or arranged in it stands: the agent said it deliberately, and the customer is acting on it.`,
      `When the customer accepts, confirms or agrees to something the agent offered, your reply must carry out that exact thing and give the concrete next step for it. Never route them somewhere other than what they just agreed to — a different seller, marketplace, link, channel, price or procedure — and never replace an arrangement made in this conversation with the general process described in the context below.`,
      `Settle what the customer just asked for or agreed to first. Only once that is handled may you add anything further, and only if it genuinely helps: an extra offer, upsell or paid service must never come before, displace or delay the step the customer is waiting for.`,
      // Agents reported that almost every generated reply ended with a pitch.
      // Customers read that as spam, and it undermines the reply that was
      // actually asked for. The default is now silence about paid services.
      `DEFAULT TO NOT SELLING. Most replies should mention no paid service, package, upgrade or offer at all. Do not close with a pitch, a price list, a "we also offer…" line or a nudge towards another product out of habit. A reply that only answers the question is a good reply.`,
      `Mention a paid service in exactly three situations, and in no others: (a) the customer asked about it, about pricing, or about what else is available; (b) it is the direct, necessary answer to the problem they have just described, and saying nothing would leave them stuck; (c) the agent's own earlier message in this conversation already raised it and the customer is replying to that. If none of those is true, leave it out entirely.`,
      `Even when one of those applies, keep it to a single short sentence at the end, factual and matched to what they actually need — never a menu of services, never more than one offer, and never attached to a complaint, an apology, a delivery problem or any message where the customer is unhappy or still waiting for something.`,
      `Be specific and concrete. Never invent prices, policies, delivery times or product capabilities that are not in the context below.`,
      `Use the knowledge base excerpts where they are relevant, rephrased naturally — never quote them verbatim and never print the [KBn] markers. Where an excerpt describes a general process that conflicts with what this conversation has already agreed, the conversation wins and the excerpt is left out.`,
      `If the context genuinely does not answer the question, say what you can and offer to confirm, rather than guessing.`,
    ];

    const systemPrompt = [
      ...baseRules,
      ...(rewriteMode ? rewriteRules : generateRules),
      // A mechanical transform needs no business context; feeding it in only
      // tempts the model to rewrite the content instead of the text.
      textOnly || !workspaceCtx ? "" : `\nBusiness context:\n${workspaceCtx}`,
      textOnly || !crmLines.length ? "" : `\nCustomer CRM data:\n${crmLines.join("\n")}`,
      textOnly || !kbBlock ? "" : `\nKnowledge base excerpts:\n${kbBlock}`,
      textOnly || !transcript ? "" : `\nRecent conversation (oldest to newest):\n${transcript}`,
      textOnly || !agentPriorMessage
        ? ""
        : `\nThe AGENT'S LAST MESSAGE, which everything below is a response to (whatever it offers, promises or arranges is already agreed — your reply continues from it):\n"""\n${agentPriorMessage}\n"""`,
      textOnly || !pendingBlock
        ? ""
        : `\nThe customer's UNANSWERED MESSAGES — everything they have sent since the agent last replied, oldest first. Your reply must answer ALL of them, not only the last one:\n"""\n${pendingBlock}\n"""`,
    ]
      .filter(Boolean)
      .join("\n");

    const instruction = actionInstruction(action, {
      targetLanguage: data.targetLanguage,
      customPrompt: data.customPrompt,
      hasDraft: draft.length > 0,
    });

    const userMsg = [
      instruction,
      // In rewrite mode the composer text IS the message being transformed. In
      // generate mode it is the agent's brief for the reply, and labelling it
      // "DRAFT" there made the model treat it as stray text and drop it.
      draft
        ? rewriteMode
          ? `\n\nDRAFT:\n"""\n${draft}\n"""`
          : `\n\nAGENT'S NOTES — what this reply has to say, written by the agent for you. Instructions, not text to send:\n"""\n${draft}\n"""`
        : "",
      rewriteMode
        ? `\n\nReturn the transformed draft only. Before you answer, re-read the draft and list to yourself what it commits to, offers, states or asks — then confirm each one is still present in your output, in the same strength and specificity.`
        : `\n\nBefore you answer: list to yourself every open point across the customer's unanswered messages — each question, each request, each thing they provided or completed, each attachment — and every separate point in the agent's notes if there are any. Then check your reply deals with all of them, each in a complete sentence of its own. If any of those points accepts or confirms something, work out from the agent's own previous message exactly what that was, and deliver that one thing rather than an alternative route to it.`,
      data.regenerate
        ? "\n\nThe agent rejected your previous suggestion: take a genuinely different angle this time, not a reworded version of it."
        : "",
    ]
      .filter(Boolean)
      .join("");

    const aiMessages: AIMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ];

    // A rewrite is a transformation, not a brainstorm — low temperature keeps
    // it faithful to the draft. Only composing a fresh reply benefits from
    // any spread, and "regenerate" asks for a deliberately different take.
    const temperature = data.regenerate ? 0.85 : rewriteMode ? 0.2 : 0.5;

    // A "generate" covers a whole run of unanswered messages plus whatever the
    // agent typed into the composer as notes, so the old 400/700 budgets cut
    // replies off mid-sentence. Reasoning models make it worse: their thinking
    // tokens come out of the same budget, so the visible answer can die after
    // one line.
    //
    // These caps are deliberately generous because max_tokens is a ceiling,
    // not a charge: you pay for tokens the model actually emits, so a cap that
    // is never reached costs nothing. Truncating does cost — the "length"
    // retry below re-sends the entire prompt (30 messages + KB excerpts +
    // business context) for a second call, so one truncation roughly doubles
    // both the bill and the wait. Sizing the first call to succeed is the
    // cheaper path.
    const baseBudget =
      action === "expand" ? 2000 : action === "shorten" ? 400 : action === "generate" ? 3000 : 1200;

  const req: ChatRequest = {
    model: await modelPromise,
    messages: aiMessages,
    temperature,
    max_tokens: baseBudget,
    // The default budget is 60s. A reply carries 20 messages of history plus
    // the business context, and a thinking model can take a while over that,
    // so give it room before calling it a timeout.
    timeout_ms: 90_000,
  };

  return { workspaceId: conv.workspace_id, req, baseBudget, action };
}

/**
 * Non-streaming entry point. The UI uses the streaming endpoint; this stays
 * for callers that need the finished reply in one piece (and as the fallback
 * when streaming is unavailable).
 */
export const aiReplyAssistant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => input.parse(v))
  .handler(async ({ data, context }): Promise<ReplyAssistantResult> => {
    const { supabase, userId } = context;
    const { workspaceId, req, baseBudget, action } = await buildReplyRequest(
      supabase as SupabaseClient<Database>,
      userId,
      data,
    );

    const call = (budget: number) =>
      runChat({
        workspaceId,
        userId,
        feature: "reply_assistant",
        request: { ...req, max_tokens: budget },
      });

    let res: Awaited<ReturnType<typeof runChat>>;
    try {
      try {
        res = await call(baseBudget);
      } catch (first) {
        // One retry, only for the failures that pass on their own: a slow
        // first call (cold model) or a momentary provider hiccup. Anything
        // else — a bad key, a missing model, no credits — is re-thrown at
        // once, because retrying it only doubles the wait.
        if (
          first instanceof AIError &&
          (first.type === "timeout" || first.type === "server" || first.type === "network")
        ) {
          res = await call(baseBudget);
        } else {
          throw first;
        }
      }
    } catch (error) {
      if (error instanceof AIError && error.type === "billing") {
        throw new Error(PROVIDER_CREDITS_MESSAGE);
      }
      // Every other AIError carried the provider's raw JSON body as its
      // message. That body never survives the trip to the browser usefully:
      // the client formatter sees a string starting with "{" and falls back to
      // "AI reply could not be generated…", so the actual cause — a revoked
      // key, a model name the provider does not have, a project with no
      // access — was invisible in the UI and in support tickets. Translate it
      // here, where the structured error still exists.
      if (error instanceof AIError) {
        console.error("[ai.reply_assistant] provider call failed", {
          type: error.type,
          httpStatus: error.httpStatus,
          provider: error.providerKind,
          body: error.message.slice(0, 500),
        });
        throw new Error(describeProviderFailure(error));
      }
      throw error;
    }

    // The model ran out of output budget — the agent would have been handed a
    // reply that stops mid-sentence ("As part of"). One retry with double the
    // budget; if that fails too, the shorter answer is still better than none.
    if (res.finish_reason === "length") {
      console.warn("[ai.reply_assistant] response truncated, retrying with a larger budget", {
        action,
        budget: baseBudget,
        completionTokens: res.usage?.completion_tokens,
      });
      try {
        const wider = await call(baseBudget * 2);
        if ((wider.content || "").trim()) res = wider;
      } catch {
        /* keep the truncated-but-real answer */
      }
    }

    const reply = (res.content || "").trim().replace(/^"+|"+$/g, "");

    return {
      reply,
      model: res.model,
      providerKind: res.providerKind,
      tokens: res.usage?.total_tokens ?? 0,
      action: data.action as ReplyAction,
    };
  });
