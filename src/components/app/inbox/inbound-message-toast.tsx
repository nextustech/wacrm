/**
 * Inbound-message toast.
 *
 * A brief, self-contained card for a new message — no page-dimming overlay
 * behind it, so it never gets in the way of whatever the agent is doing.
 *
 * The card follows the product's notification style: a dark panel, a small
 * channel icon, a title, a white two-line body, a timestamp, and primary-
 * colored text actions with an animated underline on hover — plus a progress
 * bar that drains over the toast's lifetime. It stays dark in both themes,
 * by design.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { ChannelIcon, channelMeta } from "./channel-icon";
import { cn } from "@/lib/utils";

const TOAST_DURATION_MS = 3000;

/** No-op now that the toast has no backdrop; kept so existing mounts (e.g.
 *  __root.tsx) don't need touching. */
export function InboundMessageBackdrop() {
  return null;
}

/** "1 Jan 2026, 9:23 pm" — the format used across the notification panels. */
function stamp(date: Date) {
  const day = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = date
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .toLowerCase();
  return `${day}, ${time}`;
}

function InboundMessageCard({
  channel,
  rawChannel,
  name,
  body,
  onOpen,
  onDismiss,
}: {
  channel: string;
  rawChannel?: string | null;
  name: string;
  body: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { color } = channelMeta(rawChannel ?? channel);
  const [now] = useState(() => new Date());

  return (
    <div
      className={cn(
        "pointer-events-auto relative w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-control",
        "border border-white/15 bg-[#0d1014] shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]",
        "animate-in fade-in-0 slide-in-from-top-2 duration-200",
      )}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="absolute right-2.5 top-2.5 text-white/50 transition-colors hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="px-3.5 pb-3 pt-3">
        <div className="flex items-center gap-1.5 pr-6">
          <ChannelIcon
            channel={rawChannel ?? channel}
            boxed
            className="h-4 w-4 shrink-0 ring-1 ring-white/20"
          />
          <span className="truncate text-[13px] font-semibold leading-none text-white">{name}</span>
        </div>

        <p className="mt-2 line-clamp-2 text-[12.5px] leading-[1.45] text-white">{body}</p>

        <p className="mt-2.5 text-[11px] leading-none text-white/45">{stamp(now)}</p>

        <div className="mt-2.5 flex items-center gap-2 text-[12px]">
          <button
            type="button"
            onClick={onOpen}
            className="relative font-medium text-primary transition-colors after:absolute after:inset-x-0 after:-bottom-0.5 after:h-px after:origin-left after:scale-x-0 after:bg-primary after:transition-transform after:duration-200 hover:after:scale-x-100"
          >
            Open conversation
          </button>
          <span aria-hidden className="text-white/35">
            ·
          </span>
          <button
            type="button"
            onClick={onDismiss}
            className="relative font-medium text-primary transition-colors after:absolute after:inset-x-0 after:-bottom-0.5 after:h-px after:origin-left after:scale-x-0 after:bg-primary after:transition-transform after:duration-200 hover:after:scale-x-100"
          >
            Dismiss
          </button>
        </div>
      </div>

      <CountdownBar durationMs={TOAST_DURATION_MS} color={color} />
    </div>
  );
}

/** Thin bar that drains over the toast's lifetime, so the dismissal feels intentional. */
function CountdownBar({ durationMs, color }: { durationMs: number; color: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Start at full width, then drive it to zero on the next frame so the
    // transition actually runs.
    const frame = requestAnimationFrame(() => {
      node.style.transitionDuration = `${durationMs}ms`;
      node.style.transform = "scaleX(0)";
    });
    return () => cancelAnimationFrame(frame);
  }, [durationMs]);

  return (
    <div className="h-0.5 w-full bg-white/8">
      <div
        ref={ref}
        className="h-full w-full origin-left transition-transform ease-linear"
        style={{ transform: "scaleX(1)", background: color }}
      />
    </div>
  );
}

export function showInboundMessageToast(args: {
  channel: string;
  rawChannel?: string | null;
  name: string;
  body: string;
  onOpen: () => void;
}) {
  toast.custom(
    (id) => (
      <InboundMessageCard
        channel={args.channel}
        rawChannel={args.rawChannel}
        name={args.name}
        body={args.body}
        onOpen={() => {
          toast.dismiss(id);
          args.onOpen();
        }}
        onDismiss={() => toast.dismiss(id)}
      />
    ),
    { duration: TOAST_DURATION_MS },
  );
}
