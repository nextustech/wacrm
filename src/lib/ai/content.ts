/**
 * Helpers for the multimodal `AIMessage.content` union.
 *
 * `content` is a plain string almost everywhere; parts appear only when an
 * image or document is attached. Rather than make every consumer handle both
 * shapes, they narrow through here.
 */

import type { AIContentPart, AIMessage } from "./types";

/** MIME types we are prepared to hand to a vision model as an image. */
export const SUPPORTED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** MIME types we hand to a model as a document for it to read directly. */
export const SUPPORTED_DOC_MIME = new Set(["application/pdf"]);

/**
 * MIME types no provider accepts, but whose text we can extract ourselves
 * (see doc-extract.server.ts) and send as ordinary text.
 *
 * `application/msword` and `application/vnd.ms-excel` are on the list despite
 * naming the legacy binary formats, because mail clients and WhatsApp apply
 * them to .docx and .csv files constantly. Nothing is decided by this set
 * beyond "worth opening" — the extractor sniffs the bytes and returns null for
 * anything genuinely unreadable.
 */
export const EXTRACTABLE_DOC_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/msword",
  "application/vnd.ms-excel",
]);

/**
 * The text-only view of a message.
 *
 * Binary parts become a short label, not an empty string: a transcript that
 * silently drops the attachment reads as if nothing was sent, and the model
 * fills the gap by guessing.
 */
export function contentToText(content: string | AIContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "image") return "[image attached]";
      return p.filename ? `[document attached: ${p.filename}]` : "[document attached]";
    })
    .filter(Boolean)
    .join("\n");
}

/** True when any message carries a binary part. */
export function hasBinaryParts(messages: AIMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content !== "string" && m.content.some((p) => p.type !== "text"),
  );
}

/** Normalises either shape to an array of parts. */
export function toParts(content: string | AIContentPart[]): AIContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Base64-encodes bytes without `Buffer`, which the Worker runtime does not
 * provide. `String.fromCharCode(...bytes)` blows the call stack somewhere
 * around 100k arguments, so this goes through in chunks.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
