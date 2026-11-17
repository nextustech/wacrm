/**
 * Public embed page for a named Chat Widget (embedded systems).
 *
 * Fetches the resolved config from /api/public/widget/config/:widgetId,
 * applies routing (which may swap the underlying chatbot or hide the
 * widget entirely for the current URL), then renders LiveChatWidget.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Maximize2, MessageCircle } from "lucide-react";
import { LiveChatWidget } from "@/components/app/widget/live-chat-widget";

type WidgetWindowState = "open" | "minimized" | "maximized";
/** The sizes the widget reopens at — "minimized" is a hidden state, not a size. */
type WidgetSize = "open" | "maximized";

function windowStateKey(widgetId: string) {
  return `wacrm.widget.window.${widgetId}`;
}

function windowSizeKey(widgetId: string) {
  return `wacrm.widget.size.${widgetId}`;
}

function readWindowState(widgetId: string): WidgetWindowState {
  try {
    const state = window.localStorage.getItem(windowStateKey(widgetId));
    if (state === "minimized" || state === "maximized") return state;
  } catch (error) {
    console.error("[widget] failed to read window state", error);
  }
  return "open";
}

function readWindowSize(widgetId: string): WidgetSize {
  try {
    if (window.localStorage.getItem(windowSizeKey(widgetId)) === "maximized") return "maximized";
  } catch (error) {
    console.error("[widget] failed to read window size", error);
  }
  return "open";
}

interface ResolvedWidget {
  id: string;
  name: string;
  chatbotId: string | null;
  hide: boolean;
  config: { brandColor?: string; launcherPosition?: string; agentName?: string } & Record<
    string,
    unknown
  >;
}

export const Route = createFileRoute("/embed/w/$widgetId")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Chat" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
    ],
  }),
  component: WidgetEmbed,
});

function WidgetEmbed() {
  const { widgetId } = Route.useParams();
  const [hasEntered, setHasEntered] = useState(false);
  const maximizeButtonRef = useRef<HTMLButtonElement>(null);
  const [windowState, setWindowState] = useState<WidgetWindowState>(() =>
    typeof window === "undefined" ? "open" : readWindowState(widgetId),
  );
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error" | "hidden";
    data?: ResolvedWidget;
    error?: string;
  }>({ status: "loading" });

  useEffect(() => {
    setWindowState(readWindowState(widgetId));
  }, [widgetId]);

  useEffect(() => {
    if (windowState === "minimized" && state.status === "ready") {
      maximizeButtonRef.current?.focus();
    }
  }, [state.status, windowState]);

  // The loader frames this page over the host site, so anything the app paints
  // behind the panel shows through as a white card around the launcher.
  // Clearing the backgrounds is not enough on its own: the theme bootstrap sets
  // `color-scheme` on <html>, and a resolved light/dark scheme makes the browser
  // paint an opaque canvas behind the iframe regardless of `background`.
  useEffect(() => {
    const { documentElement: html, body } = document;
    const previous = {
      htmlScheme: html.style.colorScheme,
      htmlBg: html.style.background,
      bodyBg: body.style.background,
    };
    html.style.colorScheme = "normal";
    html.style.setProperty("background", "transparent", "important");
    body.style.setProperty("background", "transparent", "important");
    return () => {
      html.style.colorScheme = previous.htmlScheme;
      html.style.background = previous.htmlBg;
      body.style.background = previous.bodyBg;
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setHasEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (state.status !== "ready") return;
    window.parent.postMessage({ wacrm: "window-state", state: windowState }, "*");
  }, [state.status, windowState]);

  const changeWindowState = (next: WidgetWindowState) => {
    setWindowState(next);
    try {
      window.localStorage.setItem(windowStateKey(widgetId), next);
      // Minimizing must not erase which size to come back to.
      if (next !== "minimized") window.localStorage.setItem(windowSizeKey(widgetId), next);
    } catch (error) {
      console.error("[widget] failed to save window state", error);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url") || "";
    const lang = (params.get("lang") || navigator.language).slice(0, 5);
    fetch(
      `/api/public/widget/config/${widgetId}?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}`,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "failed");
        return r.json();
      })
      .then((data: ResolvedWidget) => {
        if (data.hide || !data.chatbotId) return setState({ status: "hidden" });
        setState({ status: "ready", data });
        // beacon 'open' when the iframe loads
        try {
          const beacon = new Blob([JSON.stringify({ widgetId, event: "open", url })], {
            type: "application/json",
          });
          navigator.sendBeacon?.("/api/public/widget/beacon", beacon);
        } catch {
          /* noop */
        }
      })
      .catch((e) => setState({ status: "error", error: String(e?.message ?? e) }));
  }, [widgetId]);

  if (state.status === "loading") {
    return (
      <div className="fixed inset-0 grid place-items-center bg-transparent text-sm text-muted-foreground">
        Loading
      </div>
    );
  }
  if (state.status === "hidden") return null;
  if (state.status === "error") {
    return (
      <div className="fixed inset-0 grid place-items-center bg-background p-4 text-sm text-destructive">
        {state.error}
      </div>
    );
  }
  const cfg = state.data!.config;
  const minimized = windowState === "minimized";
  const maximized = windowState === "maximized";
  const accent = typeof cfg.brandColor === "string" ? cfg.brandColor : "#075E54";

  // Grow out of whichever corner the launcher sits in, so the panel reads as
  // coming from the button rather than sliding in from an unrelated edge.
  const position = typeof cfg.launcherPosition === "string" ? cfg.launcherPosition : "bottom-right";
  const isLeft = position.endsWith("left");
  const isTop = position.startsWith("top");
  const corner = `${isTop ? "top-4" : "bottom-4"} ${isLeft ? "left-4" : "right-4"}`;
  const originCls = isTop
    ? isLeft
      ? "origin-top-left"
      : "origin-top-right"
    : isLeft
      ? "origin-bottom-left"
      : "origin-bottom-right";
  // Collapsing by animating width/height drags the whole layout along with it.
  // Scaling the panel down onto the launcher's corner instead reads as the chat
  // tucking itself back inside the button it came out of.
  const collapsedCls = "scale-[.28] opacity-0";
  const easing = "duration-[420ms] ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none";

  return (
    <>
      <div
        className={`fixed z-50 flex flex-col overflow-hidden bg-background shadow-2xl transition-[width,height,inset,border-radius,opacity,transform] ${easing} ${originCls} ${
          maximized
            ? "inset-0 rounded-none"
            : `${corner} h-[min(680px,calc(100dvh-2rem))] w-[min(420px,calc(100vw-2rem))] rounded-control`
        } ${
          minimized
            ? `pointer-events-none ${collapsedCls}`
            : hasEntered
              ? "scale-100 opacity-100"
              : collapsedCls
        }`}
        aria-hidden={minimized}
        inert={minimized}
      >
        <LiveChatWidget
          chatbotId={state.data!.chatbotId!}
          accent={accent}
          compact
          isMaximized={maximized}
          isMinimized={minimized}
          onToggleMaximize={() => changeWindowState(maximized ? "open" : "maximized")}
          onClose={() => changeWindowState("minimized")}
        />
      </div>
      {/* Kept mounted so it can scale up as the panel scales away, rather than
          popping in once the panel has already gone. */}
      <button
        ref={maximizeButtonRef}
        type="button"
        onClick={() => changeWindowState(readWindowSize(widgetId))}
        aria-label="Live Chat"
        title="Live Chat"
        aria-hidden={!minimized}
        inert={!minimized}
        className={`fixed ${corner} z-50 inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm font-semibold text-white shadow-xl transition-[transform,opacity] ${easing} ${originCls} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
          minimized && hasEntered
            ? "scale-100 opacity-100 hover:scale-[1.03] active:scale-[.98]"
            : "pointer-events-none scale-50 opacity-0"
        }`}
        style={{ backgroundColor: accent }}
      >
        <MessageCircle className="h-4 w-4" />
        <span>Live Chat</span>
      </button>
    </>
  );
}
