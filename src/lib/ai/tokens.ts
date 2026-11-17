/**
 * Token estimation. We avoid shipping tiktoken to the Worker runtime — instead
 * we use a fast heuristic (~4 chars/token for English, ~2.5 for CJK). Providers
 * report actual usage on success; the estimate is used for pre-flight sizing
 * and when a provider omits usage.
 */

import type { AIMessage, TokenUsage } from "./types";
import { toParts } from "./content";

/**
 * What one attached file costs in prompt tokens, approximately.
 *
 * Providers charge images by pixel area (Anthropic is roughly width*height/750)
 * and PDFs by extracted page, neither of which is knowable from the base64
 * blob without decoding it. These are deliberately generous stand-ins: the
 * estimate is only used for pre-flight rate limiting and as the cost fallback
 * when a provider omits usage, so over-counting is the safe direction.
 */
const IMAGE_TOKENS = 1_200;
const DOCUMENT_TOKENS = 3_000;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough heuristic covering latin + CJK.
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

export function estimateMessageTokens(messages: AIMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // ~4 token overhead per message
    for (const part of toParts(m.content)) {
      if (part.type === "text") total += estimateTokens(part.text);
      else if (part.type === "image") total += IMAGE_TOKENS;
      else total += DOCUMENT_TOKENS;
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(JSON.stringify(tc.arguments)) + 6;
      }
    }
  }
  return total + 3; // priming
}

export function mergeUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
    total_tokens: (a?.total_tokens ?? 0) + (b?.total_tokens ?? 0),
  };
}
