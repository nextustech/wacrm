/**
 * Suggested instructions for the AI reply assistant.
 *
 * The custom-instruction box started empty with one generic placeholder, so
 * agents had to invent a phrasing before the assistant was any use. These are
 * worked out from what the conversation actually looks like right now — the
 * customer's last message and the agent's last message — so the first thing
 * an agent sees is a sentence that fits the thread in front of them.
 *
 * Deliberately computed here rather than asked of the model: it costs nothing,
 * appears instantly as the popover opens, and is predictable enough to test.
 */

export type ReplyHint = {
  /** Short chip label. */
  label: string;
  /** The instruction actually sent to the assistant. */
  instruction: string;
};

export type HintMessage = {
  direction: string | null;
  body: string | null;
  message_type?: string | null;
  created_at?: string | null;
};

const QUESTION =
  /\?|\b(how|what|when|where|which|why|who|can you|could you|do you|is it|are you)\b/i;
const PRICE =
  /\b(price|pricing|cost|costs|how much|quote|quotation|rate|fee|charges?|discount|offer)\b/i;
const UNHAPPY =
  /\b(not working|doesn'?t work|broken|issue|problem|error|fail(ed|ing)?|bug|complain|refund|cancel|disappointed|frustrat|angry|worst|bad experience|still waiting|no response)\b/i;
const WAITING = /\b(any update|update\?|still waiting|when will|how long|eta|status|progress)\b/i;
const AGREEMENT =
  /\b(ok(ay)?|yes|sure|agreed|confirm(ed)?|deal|go ahead|proceed|accept(ed)?|sounds good|fine|alright)\b/i;
const THANKS = /\b(thank you|thanks|thx|appreciate|great|awesome|perfect)\b/i;
const GREETING = /^\s*(hi|hello|hey|assalamu|salam|good (morning|afternoon|evening))\b/i;

/** Short, agreement-shaped message with nothing else in it. */
const isBareAgreement = (text: string): boolean =>
  text.trim().length <= 24 && AGREEMENT.test(text) && !QUESTION.test(text);

/**
 * Up to four suggestions, most relevant first.
 *
 * `messages` is the recent tail of the thread, oldest first — exactly what
 * `useMessages` already holds.
 */
export function buildReplyHints(messages: HintMessage[]): ReplyHint[] {
  const inbound = [...messages].reverse().find((m) => m.direction === "inbound");
  const outbound = [...messages].reverse().find((m) => m.direction === "outbound");
  const lastCustomer = (inbound?.body ?? "").trim();
  const lastAgent = (outbound?.body ?? "").trim();
  const customerSpokeLast =
    !!inbound &&
    (!outbound ||
      new Date(inbound.created_at ?? 0).getTime() >= new Date(outbound.created_at ?? 0).getTime());

  const hints: ReplyHint[] = [];
  const add = (label: string, instruction: string) => {
    if (hints.length < 6 && !hints.some((h) => h.label === label)) {
      hints.push({ label, instruction });
    }
  };

  // Nothing from the customer yet — this is an opening message.
  if (!lastCustomer) {
    add(
      "Open the conversation",
      "Write a short, warm opening message that introduces us and asks how we can help. Do not pitch anything.",
    );
    add(
      "Follow up politely",
      "Write a brief, polite follow-up on our previous message, without pressure and without repeating the whole offer.",
    );
    return hints;
  }

  if (UNHAPPY.test(lastCustomer)) {
    add(
      "Acknowledge the problem",
      "Acknowledge the problem plainly, take responsibility where it is ours, and give the concrete next step and a realistic timeline. Do not mention any paid service.",
    );
    add(
      "Ask for details",
      "Ask only for the specific details we need to investigate this — nothing else, and no apology padding.",
    );
  }

  if (WAITING.test(lastCustomer)) {
    add(
      "Give a status update",
      "Give a clear status update with what is done, what is left, and a specific time or date. No marketing.",
    );
  }

  if (PRICE.test(lastCustomer)) {
    add(
      "Answer on price",
      "Answer the pricing question directly with the figures we actually have, then give the next step to proceed. One option, not a menu.",
    );
  }

  // Only while their "ok" is still the last word — once we have replied, the
  // thing they agreed to has already been carried out.
  if (customerSpokeLast && isBareAgreement(lastCustomer) && lastAgent) {
    add(
      "Carry out what they agreed",
      "They have agreed to what we last proposed. Confirm it and give the exact next step for that same thing — do not re-explain and do not offer alternatives.",
    );
  }

  if (QUESTION.test(lastCustomer)) {
    add(
      "Answer their question",
      "Answer the customer's question directly and specifically in the first sentence, then stop. Nothing extra.",
    );
  }

  if (THANKS.test(lastCustomer) && lastCustomer.length < 60) {
    add(
      "Close warmly",
      "Reply briefly and warmly, and leave the door open for anything else. Do not add an offer.",
    );
  }

  if (GREETING.test(lastCustomer) && lastCustomer.length < 40) {
    add("Greet and ask", "Greet them back briefly and ask what they need help with today.");
  }

  if (!customerSpokeLast && lastAgent) {
    add(
      "Nudge for a reply",
      "Write a short, friendly nudge asking whether they had a chance to look at our last message. Keep it to two sentences.",
    );
  }

  // Always useful, and a good default when nothing above matched.
  add(
    "Ask when they're available",
    "Ask when they are available for a short call, and offer two concrete time options.",
  );
  add(
    "Confirm and summarise",
    "Summarise what has been agreed so far in two or three short lines, and ask them to confirm.",
  );

  return hints;
}

/**
 * The standing library — always offered, under the suggestions that match this
 * particular conversation. These are the instructions agents reach for again
 * and again, written out so nobody has to phrase them from scratch.
 *
 * None of them asks the model to sell anything: pitching is opt-in, through
 * the "Offer the next step" entry, and even that is kept to one line.
 */
export const GENERAL_HINTS: Array<{ group: string; hints: ReplyHint[] }> = [
  {
    group: "Answer",
    hints: [
      {
        label: "Answer directly",
        instruction:
          "Answer the customer's question directly and specifically in the first sentence, then stop. Nothing extra.",
      },
      {
        label: "Answer in detail",
        instruction:
          "Answer fully, in short numbered steps the customer can follow, using only facts from this conversation and our business context.",
      },
      {
        label: "Say what we can't do",
        instruction:
          "Explain honestly what is not possible here and why, in one or two sentences, then give the closest alternative we can actually offer.",
      },
      {
        label: "Admit we don't know yet",
        instruction:
          "Say plainly that we do not have the answer yet, state who is checking and when we will come back with it. Do not guess.",
      },
    ],
  },
  {
    group: "Move it forward",
    hints: [
      {
        label: "Give the next step",
        instruction:
          "State the single next step the customer should take, concretely, and what happens after they do it.",
      },
      {
        label: "Ask for what we need",
        instruction:
          "Ask only for the specific information or files we still need to proceed. List them briefly, nothing else.",
      },
      {
        label: "Ask when they're available",
        instruction:
          "Ask when they are available for a short call, and offer two concrete time options.",
      },
      {
        label: "Confirm and summarise",
        instruction:
          "Summarise what has been agreed so far in two or three short lines, and ask them to confirm.",
      },
      {
        label: "Send credentials safely",
        instruction:
          "Hand over the access details clearly and in a readable layout, and tell them to change the password after their first sign-in.",
      },
    ],
  },
  {
    group: "Difficult moments",
    hints: [
      {
        label: "Apologise and fix",
        instruction:
          "Acknowledge the problem plainly, take responsibility where it is ours, and give the concrete next step and a realistic timeline. Do not mention any paid service.",
      },
      {
        label: "Push back politely",
        instruction:
          "Disagree politely and explain our position in one or two sentences, without blaming the customer, and offer a way forward.",
      },
      {
        label: "Explain a delay",
        instruction:
          "Explain the delay honestly, say what is being done about it and give a specific new date. No excuses, no marketing.",
      },
      {
        label: "Decline a discount",
        instruction:
          "Decline the discount politely, explain in one sentence what the price covers, and offer a smaller scope or payment split instead if that is reasonable.",
      },
      {
        label: "De-escalate",
        instruction:
          "Lower the temperature: acknowledge how it has felt from their side, state one concrete thing we are doing now, and invite them to reply with anything we missed.",
      },
    ],
  },
  {
    group: "Follow up",
    hints: [
      {
        label: "Nudge for a reply",
        instruction:
          "Write a short, friendly nudge asking whether they had a chance to look at our last message. Keep it to two sentences.",
      },
      {
        label: "Check in after delivery",
        instruction:
          "Check in on how things are going since we delivered, and ask whether anything needs adjusting. Do not sell.",
      },
      {
        label: "Close the conversation",
        instruction:
          "Thank them, confirm everything is done, and tell them how to reach us if anything comes up later.",
      },
      {
        label: "Offer the next step",
        instruction:
          "Only if it genuinely fits what they just said, mention in ONE short sentence at the end the single service that would help them next, with no price list and no pressure.",
      },
    ],
  },
  {
    group: "Style",
    hints: [
      {
        label: "Keep it very short",
        instruction: "Reply in at most two short sentences. No greeting, no sign-off, no filler.",
      },
      {
        label: "Reply in their language",
        instruction:
          "Reply in the same language the customer used in their last message, naturally rather than translated.",
      },
      {
        label: "Make it warmer",
        instruction:
          "Keep every fact exactly as it is, but make the wording warmer and more personal.",
      },
      {
        label: "Make it more formal",
        instruction:
          "Keep every fact exactly as it is, but make the wording more formal and businesslike.",
      },
    ],
  },
];
