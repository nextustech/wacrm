/**
 * Split an email body into the new reply and the quoted thread below it.
 *
 * Postmark and Mailgun hand us a pre-stripped reply (`StrippedTextReply` /
 * `stripped-text`); the Gmail API does not, so a raw Gmail reply arrives with
 * the entire prior thread appended and the few words the customer actually
 * wrote get lost in it. This finds the earliest quote marker and cuts there.
 */

export interface SplitEmailBody {
  /** What the sender actually typed this time. */
  reply: string;
  /** The quoted thread below it, or null when there was none. */
  quoted: string | null;
}

const QUOTE_MARKERS: RegExp[] = [
  // "On Sun, Nov 1, 2026 at 10:48 PM <someone> wrote:" — Gmail/Apple Mail.
  // The header often wraps across lines, so allow a bounded run before "wrote:".
  /^[ \t]*On\b[\s\S]{0,400}?\bwrote:[ \t]*$/m,
  // "-----Original Message-----"
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*$/im,
  // Outlook's horizontal rule above the quoted header block.
  /^[ \t]*_{5,}[ \t]*$/m,
  // Outlook header block: From: ... followed by Sent:/Date:/To:/Subject: lines.
  /^[ \t]*From:[ \t].+\n(?:[ \t]*(?:Sent|Date|To|Cc|Subject):[ \t].*\n)+/m,
  // A run of ">" quoted lines.
  /^[ \t]*>/m,
];

export function splitEmailReply(text: string | null | undefined): SplitEmailBody {
  if (!text) return { reply: "", quoted: null };
  const normalized = text.replace(/\r\n/g, "\n");

  let cut = -1;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(normalized);
    if (match && (cut === -1 || match.index < cut)) cut = match.index;
  }
  if (cut === -1) return { reply: normalized.trim(), quoted: null };

  const reply = normalized.slice(0, cut).trim();
  const quoted = normalized.slice(cut).trim();
  // A message that is nothing but a quote still needs something to show.
  if (!reply) return { reply: normalized.trim(), quoted: null };
  return { reply, quoted: quoted || null };
}
