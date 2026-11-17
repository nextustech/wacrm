/**
 * Client-side reader for POST /api/ai/reply-stream.
 *
 * EventSource cannot be used here because it only does GET and carries no
 * Authorization header, so this reads the SSE body off a normal fetch.
 */

export interface StreamReplyOptions {
  payload: {
    conversationId: string;
    action: string;
    draft: string;
    regenerate: boolean;
    targetLanguage?: string;
    customPrompt?: string;
  };
  token: string;
  signal?: AbortSignal;
  /** Called with the full text so far each time more arrives. */
  onDelta: (fullText: string) => void;
}

/** Resolves with the complete reply; rejects with a readable message. */
export async function streamReply(opts: StreamReplyOptions): Promise<string> {
  const res = await fetch("/api/ai/reply-stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(opts.payload),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    // Prompt assembly failures come back as plain-text HTTP errors.
    throw new Error((await res.text().catch(() => "")) || "AI reply could not be generated.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let failure: string | null = null;

  // SSE frames are separated by a blank line and can be split across reads,
  // so anything after the last "\n\n" stays in the buffer for the next chunk.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let ev: { t?: string; v?: string; message?: string };
      try {
        ev = JSON.parse(raw) as typeof ev;
      } catch {
        continue;
      }
      if (ev.t === "delta" && typeof ev.v === "string") {
        full += ev.v;
        opts.onDelta(full);
      } else if (ev.t === "error") {
        // Keep reading to the close, then throw: the server sends this as the
        // last frame, and a half-read body leaves the connection hanging.
        failure = ev.message || "AI reply could not be generated.";
      }
    }
  }

  if (failure && !full) throw new Error(failure);
  return full;
}
