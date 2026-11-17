/**
 * Mail clients ship a plain-text alternative that is hard-wrapped at ~78
 * columns, carries `[image: …]` placeholders where inline images sat, and
 * angle-brackets its (often enormous) tracking URLs. Dropped into a chat
 * bubble as-is that reads as ragged noise — the actual sentence is broken
 * across lines and the links dwarf the message.
 *
 * This reflows it for bubble rendering. Deliberate structure (blank lines,
 * bullets, quote markers, signature separators) is preserved; only the
 * mechanical 78-column wrapping is undone.
 */

/** `[image: Logo]`, `[cid:header.png]`, `[Inline image 1]`. */
const IMAGE_PLACEHOLDER = /\[\s*(?:inline\s+)?(?:image|cid)\s*[:\s][^\]\n]*\]/gi;

/** `<https://example.com/x>` — RFC-style URL wrapping. */
const BRACKETED_URL = /<\s*(https?:\/\/[^>\s]+)\s*>/gi;

/** Bullet, numbered-list or quote prefix — a real line start, never a wrap. */
const LIST_OR_QUOTE = /^\s*(?:[-*•>]|\d{1,3}[.)])\s+/;

/** `-- `, `___`, `===` and friends: signature / section separators. */
const SEPARATOR = /^\s*(?:--\s*$|[-_=*]{3,}\s*$)/;

/** Closing punctuation: the line ended because the sentence did. */
const SENTENCE_END = /[.!?]['")\]]?$/;

/** Below this a line ended on purpose rather than because the client wrapped. */
const WRAP_WIDTH = 60;

function endsWithUrl(line: string): boolean {
  const last = line.trimEnd().split(/\s/).pop() ?? "";
  return /^https?:\/\//i.test(last);
}

export function cleanEmailPlainText(text: string | null | undefined): string {
  if (!text) return "";

  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(IMAGE_PLACEHOLDER, "")
    .replace(BRACKETED_URL, "$1");

  const out: string[] = [];
  // Length of the *raw* previous line: once lines are joined the running
  // paragraph is always long, which would swallow the short line that ends it.
  let prevRawLen = 0;

  for (const raw of normalized.split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    const trimmed = line.trim();
    const prev = out.length > 0 ? out[out.length - 1] : null;

    const continuesParagraph =
      prev !== null &&
      prev.trim() !== "" &&
      trimmed !== "" &&
      prevRawLen >= WRAP_WIDTH &&
      !LIST_OR_QUOTE.test(line) &&
      !LIST_OR_QUOTE.test(prev) &&
      !SEPARATOR.test(line) &&
      !SEPARATOR.test(prev) &&
      // A wrap never lands on a sentence end — that is a deliberate break (a
      // link label, a heading), so keep it on its own line.
      !SENTENCE_END.test(prev) &&
      // A line that ends in a URL only continues when the next line is the
      // rest of that URL; prose after a link starts a new line.
      (!endsWithUrl(prev) || !/\s/.test(trimmed));

    if (continuesParagraph) {
      // A hard-wrapped URL must be glued back together, not space-separated.
      const glue = endsWithUrl(prev) && !/\s/.test(trimmed) ? "" : " ";
      out[out.length - 1] = `${prev}${glue}${trimmed}`;
    } else {
      out.push(line);
    }
    prevRawLen = trimmed.length;
  }

  return out
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Bulk mail ends in boilerplate: the legal footer, the "you received this
 * because…" notice, unsubscribe links, a postal address. None of it is the
 * message, and in a chat bubble it drowns the two lines that are. Split it off
 * so the bubble can tuck it behind a toggle.
 */
const FOOTER_MARKERS: RegExp[] = [
  /^[ \t]*you (?:received|are receiving) this\b/im,
  /^[ \t]*this (?:e-?mail|message) was sent (?:to|by)\b/im,
  /^[ \t]*(?:©|\(c\))[ \t]*\d{4}\b/im,
  /^[ \t]*(?:to )?unsubscribe\b/im,
  /^[ \t]*(?:manage|update|change) (?:your )?(?:e-?mail |notification )?(?:preferences|settings|subscription)\b/im,
  /^[ \t]*if you (?:no longer wish|do not want|don't want|would rather not)\b/im,
  /^[ \t]*(?:please )?do ?n[o']?t reply to this\b/im,
  /^[ \t]*this is an automated\b/im,
  /^[ \t]*(?:privacy policy|terms of service)\b/im,
];

/** A cut this early would hide the message itself, so leave the mail alone. */
const MIN_BODY_CHARS = 80;

export function splitEmailFooter(text: string | null | undefined): {
  body: string;
  footer: string | null;
} {
  if (!text) return { body: "", footer: null };

  let cut = -1;
  for (const marker of FOOTER_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index >= MIN_BODY_CHARS && (cut === -1 || match.index < cut)) {
      cut = match.index;
    }
  }
  if (cut === -1) return { body: text.trim(), footer: null };

  const body = text.slice(0, cut).trim();
  const footer = text.slice(cut).trim();
  if (!body) return { body: text.trim(), footer: null };
  return { body, footer: footer || null };
}

/**
 * Last-resort text for a mail with no usable `text/plain` part. Marketing and
 * transactional senders often put the content that matters — a verification
 * code, a button's target — in the HTML alternative only; without this the
 * thread shows an empty bubble.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|h[1-6]|li)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    // Curly quotes and dashes are everywhere in marketing copy; without
    // these the catch-all below turns "Don&rsquo;t" into "Don t".
    .replace(
      /&(rsquo|lsquo|apos|rdquo|ldquo|quot|mdash|ndash|hellip|middot|bull|amp|lt|gt);/g,
      (_m, name: string) =>
        ({
          rsquo: "’",
          lsquo: "‘",
          apos: "'",
          rdquo: "”",
          ldquo: "“",
          quot: '"',
          mdash: "—",
          ndash: "–",
          hellip: "…",
          middot: "·",
          bull: "•",
          amp: "&",
          lt: "<",
          gt: ">",
        })[name] ?? " ",
    )
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Below this a body is short enough to be a stub rather than the real mail. */
const STUB_BODY_CHARS = 1_500;

/** A standalone token that reads as a one-time code / short reference. */
const CODE_TOKEN = /^[A-Z0-9][A-Z0-9-]{3,11}$/;

/** Lines of a body, trimmed and emptied of blanks, for set comparison. */
function contentLines(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Pick whichever of a mail's two alternatives actually carries the content.
 *
 * Senders build the `text/plain` part from a separate template, and it
 * routinely omits what exists only as styled markup — a verification code in
 * a table cell, a button's target. The reader is then told to "enter the code
 * below" and shown no code. When the HTML holds lines the text part does not,
 * the HTML is what the human was meant to read.
 *
 * A real plain-text mail is left alone: it is long, or the HTML adds nothing
 * beyond it. Length alone is a poor signal — a six-digit code is six
 * characters — so this compares content, and treats a missing code-like token
 * as decisive on its own.
 */
/**
 * Shape of a body-choice, for the temporary `[email-body]` diagnostic. Sizes
 * and flags only — never the text itself.
 */
export type BodyChoice = {
  picked: "plain" | "html";
  plainChars: number;
  htmlChars: number;
  htmlTextChars: number;
  missingChars: number;
  missingCode: boolean;
};

export function describeBodyChoice(plain: string, html: string): BodyChoice {
  const text = plain.trim();
  const fromHtml = html.trim() ? htmlToPlainText(html) : "";
  const seen = new Set(contentLines(text));
  let missingChars = 0;
  let missingCode = false;
  for (const line of contentLines(fromHtml)) {
    if (seen.has(line)) continue;
    missingChars += line.length;
    if (CODE_TOKEN.test(line) && !text.includes(line)) missingCode = true;
  }
  return {
    picked: richestBody(plain, html) === text ? "plain" : "html",
    plainChars: text.length,
    htmlChars: html.trim().length,
    htmlTextChars: fromHtml.length,
    missingChars,
    missingCode,
  };
}

export function richestBody(plain: string, html: string): string {
  const text = plain.trim();
  if (!html.trim()) return text;
  const fromHtml = htmlToPlainText(html);
  if (!fromHtml) return text;
  if (!text) return fromHtml;
  if (text.length >= STUB_BODY_CHARS) return text;

  const seen = new Set(contentLines(text));
  let missingChars = 0;
  let missingCode = false;
  for (const line of contentLines(fromHtml)) {
    if (seen.has(line)) continue;
    missingChars += line.length;
    if (CODE_TOKEN.test(line) && !text.includes(line)) missingCode = true;
  }
  return missingCode || missingChars >= 40 ? fromHtml : text;
}
