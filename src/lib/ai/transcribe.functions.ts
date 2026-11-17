/**
 * Speech → text for the composer's dictation button.
 *
 * Why not the browser's own `SpeechRecognition`: it does not detect the
 * language. It transcribes against the single language it is told, so an agent
 * switching between Bengali, Hindi and English had to tell it which one first
 * — and in any browser without Google's speech backend (embedded webviews,
 * Brave) it does not work at all.
 *
 * Gemini takes the audio directly and writes back whatever language was
 * actually spoken, so nothing has to be configured and nothing has to be
 * guessed. The audio is sent inline and never stored.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { geminiApiKey, geminiChatModel } from "@/lib/ai/gemini.server";

/** Formats Gemini accepts inline. WebM is converted client-side before upload. */
const ACCEPTED = new Set([
  "audio/ogg",
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/aiff",
]);

const input = z.object({
  /** Base64 (no data: prefix). Capped well under Gemini's inline limit. */
  audioBase64: z.string().min(16).max(14_000_000),
  mimeType: z.string().min(3).max(64),
});

const PROMPT =
  "Transcribe this audio exactly as spoken. Write it in the language and script the " +
  "speaker actually used — do not translate, do not romanise, do not summarise, do not " +
  "add commentary or quotation marks. If the speaker mixes languages, keep the mix. " +
  "If there is no intelligible speech, return an empty string.";

export const transcribeSpeech = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((v: unknown) => input.parse(v))
  .handler(async ({ data }): Promise<{ text: string }> => {
    const mime = data.mimeType.split(";")[0]!.trim().toLowerCase();
    if (!ACCEPTED.has(mime)) {
      throw new Error(`Audio format ${mime} cannot be transcribed.`);
    }

    const key = geminiApiKey();
    if (!key) {
      throw new Error(
        "Dictation needs a Gemini key. Add GEMINI_API_KEY on the server, or configure a Gemini provider in AI Settings.",
      );
    }

    const model = geminiChatModel(null);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);

    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model,
        )}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: PROMPT },
                  { inline_data: { mime_type: mime, data: data.audioBase64 } },
                ],
              },
            ],
            // Deterministic: this is a transcription, not a composition.
            generationConfig: { temperature: 0, maxOutputTokens: 2048 },
          }),
        },
      );
    } catch (e) {
      const err = e as Error;
      throw new Error(
        err.name === "AbortError" && timedOut
          ? "Transcription timed out. Try a shorter recording."
          : `Could not reach the transcription service (${err.message}).`,
      );
    } finally {
      clearTimeout(timer);
    }

    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 200);
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        detail = parsed.error?.message ?? detail;
      } catch {
        /* keep the raw snippet */
      }
      throw new Error(`Transcription failed: ${detail}`);
    }

    const parsed = JSON.parse(body) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim()
      // The model occasionally wraps the transcript in quotes despite the
      // instruction; strip one matching pair rather than leaving them in.
      .replace(/^["“”']+|["“”']+$/g, "")
      .trim();

    return { text };
  });
