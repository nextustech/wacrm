/**
 * Application-facing entrypoints. Every AI call in the app should go through
 * `aiChat` (or `aiChatByFeature`) — never call a provider adapter directly.
 *
 * Handles: provider resolution, fallback chain, credential loading, rate limit,
 * logging, cost tracking, and error mapping.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type {
  AIMessage,
  AIProviderKind,
  AIProviderRecord,
  AIModelRecord,
  AIFeatureConfig,
  ChatRequest,
  ChatResponse,
  TokenUsage,
} from "./types";
import { getAIProvider, resolveProviderCredentials } from "./registry.server";
import { geminiChatModel, GEMINI_DEFAULT_CHAT_MODEL } from "@/lib/ai/gemini.server";
import { AIError } from "./errors";
import { computeCost } from "./cost";
import { estimateMessageTokens } from "./tokens";
import { logAIRequest } from "./logger.server";
import { enforceAIRateLimit } from "./rate-limiter.server";
import { renderTemplate } from "./prompts";
import { sbAny } from "@/lib/supabase/untyped";
import { appChatModelIds, providerChatModelId } from "./model-kind";

// ---------- Record loaders ----------

/**
 * Short-lived cache for AI *configuration* rows (providers, models, settings).
 *
 * One reply used to spend six round trips just deciding which model to call,
 * and read ai_settings three separate times with identical arguments:
 * resolveDefaultModel loads the default provider (2 queries) and then reads
 * ai_settings and ai_models again, after which runChat loads the default
 * provider a second time. None of that changes between calls.
 *
 * Only configuration is cached. AIProviderRecord holds no secret material —
 * the API key lives in the vault and is fetched per call in callWithProvider —
 * so nothing sensitive is held here. The TTL is deliberately short: a provider
 * that is disabled, re-pointed or re-keyed takes effect within it.
 */
const CONFIG_TTL_MS = 20_000;
const configCache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value as T;
  const value = await load();
  configCache.set(key, { at: Date.now(), value });
  // The map is keyed by workspace/provider/model and a Worker isolate is
  // short-lived, but a long-running Node process would grow it forever.
  if (configCache.size > 500) {
    for (const [k, v] of configCache) {
      if (Date.now() - v.at >= CONFIG_TTL_MS) configCache.delete(k);
    }
  }
  return value;
}

/** Drops cached configuration so a settings change applies immediately. */
export function invalidateAIConfigCache(): void {
  configCache.clear();
}

async function loadProvider(providerId: string): Promise<AIProviderRecord | null> {
  return cached("provider:" + providerId, () => loadProviderUncached(providerId));
}

async function loadProviderUncached(providerId: string): Promise<AIProviderRecord | null> {
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data } = await sbAny(supabaseAdmin)
    .from("ai_providers" as never)
    .select("*")
    .eq("id", providerId)
    .maybeSingle();
  return data ? mapProvider(data as never) : null;
}

async function loadDefaultProvider(workspaceId: string): Promise<AIProviderRecord | null> {
  return cached("default-provider:" + workspaceId, () => loadDefaultProviderUncached(workspaceId));
}

/**
 * The kind of provider a workspace will actually call.
 *
 * Callers need this before building a request so they can decide whether an
 * attachment is worth reading off disk at all: handing a base64 image to a
 * provider with no vision support costs upload time and prompt tokens and
 * yields nothing. Cached with everything else in this module.
 */
export async function resolveDefaultProviderKind(
  workspaceId: string,
): Promise<AIProviderKind | null> {
  const p = await loadDefaultProvider(workspaceId);
  return p && p.enabled ? p.kind : null;
}

async function loadDefaultProviderUncached(workspaceId: string): Promise<AIProviderRecord | null> {
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data: settings } = await sbAny(supabaseAdmin)
    .from("ai_settings" as never)
    .select("default_provider_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const selectedId = (settings as { default_provider_id?: string | null } | null)
    ?.default_provider_id;
  if (selectedId) {
    const { data: selected } = await sbAny(supabaseAdmin)
      .from("ai_providers" as never)
      .select("*")
      .eq("id", selectedId)
      .eq("workspace_id", workspaceId)
      .eq("enabled", true)
      .maybeSingle();
    if (selected) return mapProvider(selected as never);
  }
  const { data } = await sbAny(supabaseAdmin)
    .from("ai_providers" as never)
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    // "Auto": a tenant's own key ('workspace') beats any platform key.
    .order("credential_source", { ascending: false })
    .order("is_default", { ascending: false })
    .order("priority", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (data) return mapProvider(data as never);
  return null;
}

async function loadModel(providerId: string, modelId: string): Promise<AIModelRecord | null> {
  return cached("model:" + providerId + ":" + modelId, () => loadModelUncached(providerId, modelId));
}

async function loadModelUncached(providerId: string, modelId: string): Promise<AIModelRecord | null> {
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data } = await sbAny(supabaseAdmin)
    .from("ai_models" as never)
    .select("*")
    .eq("provider_id", providerId)
    .eq("model_id", modelId)
    .maybeSingle();
  return data ? mapModel(data as never) : null;
}

/**
 * Resolves the model id to use when a caller doesn't pin one explicitly:
 * the given provider's (or the workspace default provider's) highest-priority
 * enabled model, falling back to a known-valid Gemini model id. Every feature
 * that calls `runChat` directly (rather than going through `aiChat`) should
 * use this instead of hardcoding a model string, since a stale/invalid
 * literal here is what causes provider "invalid model ID" errors.
 */
// Discovered model catalogs include non-chat models (moderation, TTS,
// realtime/voice, embeddings, image) that reject calls to the chat
// completions endpoint with "This is not a chat model". `capabilities`
// isn't reliably populated by model-discovery, so filter by id pattern.
export async function resolveDefaultModel(
  workspaceId: string,
  providerId?: string | null,
): Promise<string> {
  // Same reasoning as the loaders above: this reads ai_settings and ai_models
  // on every call to answer a question whose answer is a workspace setting.
  return cached("default-model:" + workspaceId + ":" + (providerId ?? ""), () =>
    resolveDefaultModelUncached(workspaceId, providerId),
  );
}

async function resolveDefaultModelUncached(
  workspaceId: string,
  providerId?: string | null,
): Promise<string> {
  const p = providerId ? await loadProvider(providerId) : await loadDefaultProvider(workspaceId);
  if (!p) throw new AIError("not_found", "No AI provider configured for this workspace");
  if (p.workspaceId !== workspaceId || !p.enabled)
    throw new AIError("not_found", "AI provider is not available in this workspace");
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data: settings } = await sbAny(supabaseAdmin)
    .from("ai_settings" as never)
    .select("default_provider_id, default_model")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const { data: rows } = await sbAny(supabaseAdmin)
    .from("ai_models" as never)
    .select("model_id, is_default")
    .eq("provider_id", p.id)
    .eq("enabled", true)
    .order("is_default", { ascending: false })
    .limit(200);
  const candidates = (rows ?? []) as { model_id: string; is_default?: boolean }[];
  const configured = settings as {
    default_provider_id?: string | null;
    default_model?: string | null;
  } | null;
  const selectedModel = configured?.default_model;
  if (
    (!configured?.default_provider_id || configured.default_provider_id === p.id) &&
    selectedModel &&
    candidates.some((row) => row.model_id === selectedModel) &&
    (!appChatModelIds(p.kind) || appChatModelIds(p.kind)?.includes(selectedModel))
  ) {
    return selectedModel;
  }
  const model = providerChatModelId(p.kind, candidates);
  if (model) return model;
  if (p.kind === "gemini") return GEMINI_DEFAULT_CHAT_MODEL;
  if (p.kind === "openai") return "gpt-6-luna";
  throw new AIError("not_found", `No chat model configured for provider ${p.name}`);
}

async function loadFeatureConfig(
  workspaceId: string,
  feature: string,
): Promise<AIFeatureConfig | null> {
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data } = await sbAny(supabaseAdmin)
    .from("ai_feature_config" as never)
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("feature", feature)
    .maybeSingle();
  if (!data) return null;
  const r = data as never as Record<string, unknown>;
  return {
    workspaceId: r.workspace_id as string,
    feature: r.feature as string,
    providerId: (r.provider_id as string | null) ?? null,
    fallbackProviderIds: (r.fallback_provider_ids as string[]) ?? [],
    model: (r.model as string | null) ?? null,
    temperature: (r.temperature as number | null) ?? null,
    maxTokens: (r.max_tokens as number | null) ?? null,
    systemPrompt: (r.system_prompt as string | null) ?? null,
    enabled: (r.enabled as boolean) ?? true,
    config: (r.config as Record<string, unknown>) ?? {},
  };
}

function mapProvider(r: Record<string, unknown>): AIProviderRecord {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    kind: r.kind as never,
    name: r.name as string,
    baseUrl: (r.base_url as string | null) ?? null,
    apiKeySecretName: (r.api_key_secret_name as string | null) ?? null,
    credentialSource: (r.credential_source as "platform" | "workspace" | null) ?? "platform",
    vaultSecretId: (r.vault_secret_id as string | null) ?? null,
    apiKeyLast4: (r.api_key_last4 as string | null) ?? null,
    organizationId: (r.organization_id as string | null) ?? null,
    enabled: r.enabled as boolean,
    isDefault: r.is_default as boolean,
    priority: (r.priority as number) ?? 100,
    config: (r.config as Record<string, unknown>) ?? {},
  };
}
function mapModel(r: Record<string, unknown>): AIModelRecord {
  return {
    id: r.id as string,
    providerId: r.provider_id as string,
    modelId: r.model_id as string,
    displayName: r.display_name as string,
    capabilities: (r.capabilities as Record<string, boolean>) ?? {},
    contextWindow: (r.context_window as number | null) ?? null,
    maxOutputTokens: (r.max_output_tokens as number | null) ?? null,
    inputCostPer1k: Number(r.input_cost_per_1k ?? 0),
    outputCostPer1k: Number(r.output_cost_per_1k ?? 0),
    enabled: r.enabled as boolean,
    isDefault: r.is_default as boolean,
  };
}

// ---------- Core call ----------

interface RunOpts {
  workspaceId: string;
  userId?: string | null;
  feature?: string | null;
  request: ChatRequest;
  primaryProviderId?: string | null;
  fallbackProviderIds?: string[];
  rateLimitPerMin?: number;
}

async function callWithProvider(
  provider: AIProviderRecord,
  req: ChatRequest,
): Promise<ChatResponse> {
  const impl = getAIProvider(provider.kind);
  if (provider.kind === "lovable") req = { ...req, model: geminiChatModel(req.model) };
  const creds = await resolveProviderCredentials(provider);
  return impl.chat(req, creds);
}

/** One piece of a streamed answer, or the summary that closes it. */
export type RunStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      content: string;
      model: string;
      providerId: string;
      providerKind: string;
      finishReason: ChatResponse["finish_reason"];
      usage: TokenUsage;
    };

/**
 * Streaming sibling of runChat.
 *
 * Same provider resolution, rate limiting, usage accounting and request
 * logging — the difference is that tokens reach the caller as they arrive
 * instead of after the last one. That is the whole point: generation is not
 * faster, but the agent stops staring at a spinner for the length of it.
 *
 * Two deliberate differences from runChat:
 *  - No cross-provider fallback once bytes are out. runChat can quietly retry
 *    a different provider because nobody has seen the answer yet; here the
 *    caller may already be rendering it, so a mid-stream failure is reported
 *    rather than papered over. Failures *before* the first token still throw
 *    cleanly, and the caller can fall back to runChat.
 *  - Providers that implement no stream() fall back to one buffered call,
 *    emitted as a single delta, so every provider keeps working.
 */
export async function* runChatStream(opts: RunOpts): AsyncGenerator<RunStreamEvent> {
  const providerId =
    opts.primaryProviderId ?? (await loadDefaultProvider(opts.workspaceId))?.id ?? null;
  if (!providerId) throw new AIError("not_found", "No AI provider configured for this workspace");
  const provider = await loadProvider(providerId);
  if (!provider || !provider.enabled || provider.workspaceId !== opts.workspaceId) {
    throw new AIError("not_found", "AI provider is not available in this workspace");
  }

  await enforceAIRateLimit({
    workspaceId: opts.workspaceId,
    userId: opts.userId ?? null,
    providerId: provider.id,
    feature: opts.feature ?? null,
    limit: opts.rateLimitPerMin ?? 120,
  });

  const impl = getAIProvider(provider.kind);
  const req =
    provider.kind === "lovable"
      ? { ...opts.request, model: geminiChatModel(opts.request.model) }
      : opts.request;
  const start = Date.now();

  let content = "";
  let finishReason: ChatResponse["finish_reason"] = "stop";
  let streamUsage: TokenUsage | undefined;

  try {
    if (!impl.stream) {
      const res = await callWithProvider(provider, req);
      content = res.content ?? "";
      finishReason = res.finish_reason;
      streamUsage = res.usage;
      if (content) yield { type: "delta", text: content };
    } else {
      const creds = await resolveProviderCredentials(provider);
      for await (const chunk of impl.stream(req, creds)) {
        if (chunk.delta) {
          content += chunk.delta;
          yield { type: "delta", text: chunk.delta };
        }
        if (chunk.finish_reason) finishReason = chunk.finish_reason;
        if (chunk.usage) streamUsage = chunk.usage;
      }
    }
  } catch (e) {
    const err = e as AIError | Error;
    const aiErr = err instanceof AIError ? err : null;
    await logAIRequest({
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      providerId: provider.id,
      providerKind: provider.kind,
      model: req.model,
      operation: "chat",
      feature: opts.feature,
      status:
        aiErr?.type === "rate_limit"
          ? "rate_limited"
          : aiErr?.type === "timeout"
            ? "timeout"
            : "error",
      httpStatus: aiErr?.httpStatus,
      latencyMs: Date.now() - start,
      errorType: aiErr?.type,
      errorMessage: err.message,
    });
    throw err;
  }

  // Most providers do not report usage on a stream, so fall back to the same
  // estimate runChat uses when a provider omits it — otherwise streamed
  // replies would silently vanish from cost reporting.
  const usage: TokenUsage = streamUsage ?? {
    prompt_tokens: estimateMessageTokens(req.messages),
    completion_tokens: Math.ceil(content.length / 4),
    total_tokens: 0,
  };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  const model = await loadModel(provider.id, req.model).catch(() => null);
  await logAIRequest({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    providerId: provider.id,
    providerKind: provider.kind,
    model: req.model,
    operation: "chat",
    feature: opts.feature,
    status: "success",
    latencyMs: Date.now() - start,
    usage,
    costUsd: computeCost(model, usage),
    requestPreview: { messages: req.messages.slice(-3) },
    responsePreview: { content: content.slice(0, 800) },
  });

  yield {
    type: "done",
    content,
    model: req.model,
    providerId: provider.id,
    providerKind: provider.kind,
    finishReason,
    usage,
  };
}

export async function runChat(
  opts: RunOpts,
): Promise<ChatResponse & { providerId: string; providerKind: string }> {
  const chain: string[] = [];
  if (opts.primaryProviderId) chain.push(opts.primaryProviderId);
  for (const id of opts.fallbackProviderIds ?? []) if (!chain.includes(id)) chain.push(id);

  // Fall back to workspace default if nothing was configured.
  if (chain.length === 0) {
    const def = await loadDefaultProvider(opts.workspaceId);
    if (!def) throw new AIError("not_found", "No AI provider configured for this workspace");
    chain.push(def.id);
  }

  let lastError: AIError | Error | null = null;
  for (const providerId of chain) {
    const provider = await loadProvider(providerId);
    if (!provider || !provider.enabled || provider.workspaceId !== opts.workspaceId) continue;

    const request =
      providerId === chain[0]
        ? opts.request
        : { ...opts.request, model: await resolveDefaultModel(opts.workspaceId, providerId) };

    await enforceAIRateLimit({
      workspaceId: opts.workspaceId,
      userId: opts.userId ?? null,
      providerId: provider.id,
      feature: opts.feature ?? null,
      limit: opts.rateLimitPerMin ?? 120,
    });

    // A 5xx "model overloaded" is per model: try the provider's next app chat
    // models before giving up on this provider.
    const alternates = (appChatModelIds(provider.kind) ?? [])
      .filter((m) => m !== request.model)
      .slice(0, 2);
    const models = [request.model, ...alternates];
    for (let attempt = 0; attempt < models.length; attempt++) {
    const attemptRequest = { ...request, model: models[attempt]! };
    const start = Date.now();
    try {
      const res = await callWithProvider(provider, attemptRequest);
      const model = await loadModel(provider.id, attemptRequest.model).catch(() => null);
      const usage = res.usage ?? {
        prompt_tokens: estimateMessageTokens(request.messages),
        completion_tokens: Math.ceil((res.content?.length ?? 0) / 4),
        total_tokens: 0,
      };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const cost = computeCost(model, usage);
      await logAIRequest({
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        providerId: provider.id,
        providerKind: provider.kind,
        model: attemptRequest.model,
        operation: "chat",
        feature: opts.feature,
        status: "success",
        latencyMs: Date.now() - start,
        usage,
        costUsd: cost,
        requestPreview: { messages: request.messages.slice(-3) },
        responsePreview: { content: res.content?.slice(0, 800) },
      });
      return { ...res, usage, providerId: provider.id, providerKind: provider.kind };
    } catch (e) {
      const err = e as AIError | Error;
      lastError = err;
      const aiErr = err instanceof AIError ? err : null;
      await logAIRequest({
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        providerId: provider.id,
        providerKind: provider.kind,
        model: attemptRequest.model,
        operation: "chat",
        feature: opts.feature,
        status:
          aiErr?.type === "rate_limit"
            ? "rate_limited"
            : aiErr?.type === "timeout"
              ? "timeout"
              : "error",
        httpStatus: aiErr?.httpStatus,
        latencyMs: Date.now() - start,
        errorType: aiErr?.type,
        errorMessage: err.message,
      });
      if (aiErr?.type === "server" && attempt < models.length - 1) continue;
      // Only fall through for retryable errors.
      if (aiErr && !aiErr.retryable) throw aiErr;
      break;
    }
    }
  }
  throw lastError ?? new AIError("unknown", "All providers failed");
}

// ---------- Public server functions ----------

const chatInput = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      name: z.string().optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
  model: z.string().optional(),
  providerId: z.string().uuid().optional(),
  feature: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32_000).optional(),
  response_format: z.enum(["text", "json_object"]).optional(),
  system: z.string().optional(),
  variables: z.record(z.unknown()).optional(),
});

export interface AIChatResult {
  content: string;
  model: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerId: string;
  providerKind: string;
  toolCalls: string; // JSON-encoded array (unknown args aren't serializable directly)
}

async function getWorkspaceId(userId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
  const { data } = await sbAny(supabaseAdmin)
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!data) throw new Error("No workspace found for current user");
  return (data as { workspace_id: string }).workspace_id;
}

export const aiChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => chatInput.parse(v))
  .handler(async ({ data, context }): Promise<AIChatResult> => {
    const userId = context.userId;
    const workspaceId = await getWorkspaceId(userId);

    // Optional feature config
    let featureCfg: AIFeatureConfig | null = null;
    if (data.feature) featureCfg = await loadFeatureConfig(workspaceId, data.feature);
    if (featureCfg && !featureCfg.enabled)
      throw new AIError("validation", `Feature ${data.feature} disabled`);

    const systemContent = data.system ?? featureCfg?.systemPrompt ?? undefined;
    const messages: AIMessage[] = [];
    if (systemContent)
      messages.push({
        role: "system",
        content: renderTemplate(systemContent, data.variables ?? {}),
      });
    for (const m of data.messages) {
      messages.push({ ...m, content: renderTemplate(m.content, data.variables ?? {}) });
    }

    const providerId = data.providerId ?? featureCfg?.providerId ?? null;
    const fallbacks = featureCfg?.fallbackProviderIds ?? [];

    // Pick model: request → feature config → workspace/provider default.
    let model = data.model ?? featureCfg?.model ?? "";
    if (!model) {
      model = await resolveDefaultModel(workspaceId, providerId);
    }

    const req: ChatRequest = {
      model,
      messages,
      temperature: data.temperature ?? featureCfg?.temperature ?? undefined,
      max_tokens: data.max_tokens ?? featureCfg?.maxTokens ?? undefined,
      response_format: data.response_format,
    };

    const res = await runChat({
      workspaceId,
      userId,
      feature: data.feature ?? null,
      request: req,
      primaryProviderId: providerId,
      fallbackProviderIds: fallbacks,
    });
    return {
      content: res.content,
      model: res.model,
      finishReason: res.finish_reason ?? "stop",
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      totalTokens: res.usage?.total_tokens ?? 0,
      providerId: res.providerId,
      providerKind: res.providerKind,
      toolCalls: JSON.stringify(res.tool_calls ?? []),
    };
  });
