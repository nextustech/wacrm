import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Lightbulb,
  Sparkles,
  Wand2,
  Languages,
  Scissors,
  Maximize2,
  CheckCircle2,
  SpellCheck,
  MessageSquarePlus,
  ArrowRight,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { aiReplyAssistant, type ReplyAction } from "@/lib/ai/reply-assistant.functions";
import { replyAssistantErrorMessage } from "@/lib/ai/reply-error";
import { supabase } from "@/integrations/supabase/client";
import { streamReply } from "@/lib/ai/stream-reply";
import { DictationButton } from "@/components/app/inbox/dictation-button";
import { buildReplyHints, GENERAL_HINTS } from "@/lib/inbox/reply-hints";
import { useMessages } from "@/hooks/use-messages";

interface Props {
  conversationId: string;
  draft: string;
  onApply: (text: string) => void;
  disabled?: boolean;
  /** When set, the trigger renders as a labelled row (for overflow menus) instead of an icon button. */
  triggerLabel?: string;
  /** Controlled open state. Omit for the self-managed (trigger-driven) mode. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Render a zero-size anchor instead of a visible trigger. Use with the
   * controlled props when the button that opens this lives somewhere else
   * (e.g. inside an overflow menu that unmounts on open).
   */
  hideTrigger?: boolean;
}

const TONE_ACTIONS: Array<{ id: ReplyAction; label: string; icon: React.ElementType }> = [
  { id: "tone_professional", label: "Professional", icon: Sparkles },
  { id: "tone_friendly", label: "Friendly", icon: Sparkles },
  { id: "tone_formal", label: "Formal", icon: Sparkles },
  { id: "tone_casual", label: "Casual", icon: Sparkles },
];

const EDIT_ACTIONS: Array<{ id: ReplyAction; label: string; icon: React.ElementType }> = [
  { id: "shorten", label: "Shorten", icon: Scissors },
  { id: "expand", label: "Detailed", icon: Maximize2 },
  { id: "improve", label: "Improve writing", icon: Wand2 },
  { id: "grammar", label: "Fix grammar", icon: SpellCheck },
  { id: "rewrite", label: "Rewrite", icon: RefreshCw },
  { id: "continue", label: "Continue writing", icon: ArrowRight },
];

const LANGUAGES = [
  "Afrikaans", "Albanian", "Amharic", "Arabic", "Armenian", "Azerbaijani",
  "Basque", "Belarusian", "Bengali", "Bosnian", "Bulgarian", "Burmese",
  "Catalan", "Cebuano", "Chinese (Simplified)", "Chinese (Traditional)",
  "Croatian", "Czech", "Danish", "Dutch",
  "English", "Esperanto", "Estonian",
  "Filipino", "Finnish", "French", "Galician", "Georgian", "German", "Greek",
  "Gujarati", "Haitian Creole", "Hausa", "Hawaiian", "Hebrew", "Hindi",
  "Hmong", "Hungarian",
  "Icelandic", "Igbo", "Indonesian", "Irish", "Italian",
  "Japanese", "Javanese",
  "Kannada", "Kazakh", "Khmer", "Korean", "Kurdish",
  "Kyrgyz", "Lao", "Latin", "Latvian", "Lithuanian", "Luxembourgish",
  "Macedonian", "Malagasy", "Malay", "Malayalam", "Maltese", "Maori",
  "Marathi", "Mongolian",
  "Nepali", "Norwegian",
  "Odia", "Pashto", "Persian", "Polish", "Portuguese", "Punjabi",
  "Romanian", "Russian",
  "Samoan", "Scottish Gaelic", "Serbian", "Shona", "Sindhi", "Sinhala",
  "Slovak", "Slovenian", "Somali", "Spanish", "Sundanese", "Swahili",
  "Swedish",
  "Tajik", "Tamil", "Tatar", "Telugu", "Thai", "Turkish", "Turkmen",
  "Ukrainian", "Urdu", "Uyghur", "Uzbek",
  "Vietnamese", "Welsh", "Xhosa", "Yiddish", "Yoruba", "Zulu",
];

export function AIReplyAssistant({
  conversationId,
  draft,
  onApply,
  disabled,
  triggerLabel,
  open: controlledOpen,
  onOpenChange,
  hideTrigger,
}: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const handleOpenChange = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [suggestion, setSuggestion] = useState<string>("");
  const [lastAction, setLastAction] = useState<ReplyAction | null>(null);
  const [lastLanguage, setLastLanguage] = useState<string | undefined>();
  const [customPrompt, setCustomPrompt] = useState("");
  const [langOpen, setLangOpen] = useState(false);
  const [langSearch, setLangSearch] = useState("");
  const [copied, setCopied] = useState(false);

  // Only loaded while the popover is open — the inbox already holds this
  // query, so in practice it is served from the cache.
  const { data: recentMessages } = useMessages(open ? conversationId : undefined);
  const hints = useMemo(() => {
    // The hook paginates; flatten the pages into one oldest-first tail.
    const pages = (recentMessages as { pages?: unknown[][] } | undefined)?.pages;
    const flat = Array.isArray(pages)
      ? (pages.flat() as Array<{
          direction: string | null;
          body: string | null;
          created_at?: string | null;
        }>)
      : ((recentMessages ?? []) as Array<{
          direction: string | null;
          body: string | null;
          created_at?: string | null;
        }>);
    return buildReplyHints(flat.slice(-12));
  }, [recentMessages]);

  const fn = useServerFn(aiReplyAssistant);

  // Streaming is what makes this feel responsive: the old path waited for the
  // whole reply before painting a single character. The server function is
  // kept as the fallback for when the stream cannot be opened at all.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const mut = useMutation({
    mutationFn: async (v: {
      action: ReplyAction;
      regenerate?: boolean;
      targetLanguage?: string;
      customPrompt?: string;
    }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const payload = {
        conversationId,
        action: v.action,
        draft,
        regenerate: v.regenerate ?? false,
        targetLanguage: v.targetLanguage,
        customPrompt: v.customPrompt,
      };

      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (token) {
        // Clear the previous suggestion only once we are about to replace it,
        // so a failure leaves the old text on screen instead of a blank panel.
        let started = false;
        const text = await streamReply({
          payload,
          token,
          signal: ac.signal,
          onDelta: (full) => {
            if (!started) {
              started = true;
              setLastAction(v.action);
              setLastLanguage(v.targetLanguage);
            }
            setSuggestion(full);
          },
        });
        return { reply: text };
      }

      const r = await fn({ data: payload });
      return { reply: r.reply };
    },
    onSuccess: (r, vars) => {
      setSuggestion(r.reply);
      setLastAction(vars.action);
      setLastLanguage(vars.targetLanguage);
    },
    onError: (e: Error) => {
      if (e.name === "AbortError") return;
      toast.error(replyAssistantErrorMessage(e));
    },
  });

  const run = (
    action: ReplyAction,
    extra?: { targetLanguage?: string; customPrompt?: string; regenerate?: boolean },
  ) => {
    mut.mutate({ action, ...extra });
  };

  const apply = () => {
    if (!suggestion) return;
    onApply(suggestion);
    handleOpenChange(false);
    setSuggestion("");
    setLastAction(null);
    toast.success("Applied to composer");
  };

  const copy = async () => {
    if (!suggestion) return;
    await navigator.clipboard.writeText(suggestion);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const regenerate = () => {
    if (!lastAction) return;
    run(lastAction, { targetLanguage: lastLanguage, regenerate: true });
  };

  const isBusy = mut.isPending;
  const canEdit = draft.trim().length > 0;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {hideTrigger ? (
          <span aria-hidden className="block h-0 w-0" />
        ) : triggerLabel ? (
          <Button
            type="button"
            variant="ghost"
            className="justify-start gap-2 h-9 px-2 font-normal"
            disabled={disabled}
            aria-label="AI reply assistant"
          >
            <Sparkles className={cn("h-4 w-4 text-violet-500", isBusy && "animate-pulse")} />
            {triggerLabel}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn(
              "shrink-0 rounded-full relative",
              "hover:bg-gradient-to-br hover:from-violet-500/10 hover:to-fuchsia-500/10",
            )}
            disabled={disabled}
            aria-label="AI reply assistant"
            title="AI reply assistant"
          >
            <Sparkles
              className={cn(
                "h-5 w-5 transition-colors",
                "text-violet-500",
                isBusy && "animate-pulse",
              )}
            />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        // Anchored mode drops rightwards from the "..." button and sits a bit
        // clear of the composer; the standalone trigger keeps its old framing.
        align={hideTrigger ? "start" : "end"}
        side="top"
        sideOffset={hideTrigger ? 16 : 4}
        collisionPadding={12}
        // Never taller than the space Radix measured above the anchor, so the
        // top of the panel can't be clipped off-screen.
        className="w-[380px] p-0 overflow-y-auto max-h-(--radix-popover-content-available-height)"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-popover px-3 py-2 bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 border-b border-border flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <span className="text-sm font-medium">AI Reply Assistant</span>
          <div className="ml-auto flex items-center gap-1">
            {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-muted/60 transition-colors"
              onClick={() => handleOpenChange(false)}
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Suggestion preview */}
        {suggestion && (
          <div className="p-3 border-b border-border animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="relative rounded-control border border-violet-500/20 bg-violet-500/5 p-3 pr-2 max-h-48 overflow-y-auto">
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{suggestion}</p>
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <Button size="sm" className="text-xs flex-1" onClick={apply}>
                <Check className="h-3 w-3 " /> Use this reply
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={regenerate}
                disabled={isBusy}
              >
                <RefreshCw className={cn("h-3 w-3 ", isBusy && "animate-spin")} />
                Regenerate
              </Button>
              <Button size="iconSM" variant="outline" onClick={copy} title="Copy">
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
              <Button
                size="iconSM"
                variant="outline"
                onClick={() => setSuggestion("")}
                title="Dismiss"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Actions grid */}
        <div className="p-2 space-y-2">
          {/* Generate — card-style so it reads as an interactive action, not a header */}
          <button
            type="button"
            className={cn(
              "w-full text-left rounded-xl p-3 transition-all duration-150 group cursor-pointer",
              "bg-gradient-to-br from-violet-500/10 via-fuchsia-500/8 to-violet-500/5",
              "border border-violet-500/25 hover:border-violet-500/50",
              "hover:from-violet-500/15 hover:via-fuchsia-500/12 hover:to-violet-500/8",
              "hover:shadow-md active:scale-[0.99]",
              isBusy && lastAction === "generate" && "opacity-80 pointer-events-none",
            )}
            disabled={isBusy}
            onClick={() => run("generate")}
          >
            <div className="flex items-center gap-3">
              <div className="shrink-0 h-9 w-9 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
                {isBusy && lastAction === "generate" ? (
                  <Loader2 className="h-4 w-4 text-white animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 text-white" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-sm font-semibold">Generate reply</span>
                  <span className="text-[10px] px-1.5 py-px rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-400 font-medium leading-tight">
                    AI
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground leading-tight">
                  {canEdit
                    ? "Uses your composer notes + conversation context"
                    : "Reads the chat, CRM and your business context"}
                </span>
              </div>
              {!(isBusy && lastAction === "generate") && (
                <ArrowRight className="h-4 w-4 shrink-0 text-violet-500 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
              )}
            </div>
          </button>

          <p className="px-2 text-[11px] text-muted-foreground">
            Everything below rewrites the composer text as it stands.
          </p>

          <div>
            <div className="px-2 py-1 text-[11px]  text-muted-foreground">Tone</div>
            <div className="grid grid-cols-2 gap-1">
              {TONE_ACTIONS.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant="outline"
                  className="text-xs justify-start font-normal"
                  disabled={isBusy || !canEdit}
                  onClick={() => run(a.id)}
                >
                  <a.icon className="h-3 w-3 mr-1.5" />
                  {a.label}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <div className="px-2 py-1 text-[11px]  text-muted-foreground">Edit</div>
            <div className="grid grid-cols-2 gap-1">
              {EDIT_ACTIONS.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant="outline"
                  className="text-xs justify-start font-normal"
                  disabled={isBusy || !canEdit}
                  onClick={() => run(a.id)}
                >
                  <a.icon className="h-3 w-3 mr-1.5" />
                  {a.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Translate */}
          <Popover
            open={langOpen}
            onOpenChange={(v) => {
              setLangOpen(v);
              if (!v) setLangSearch("");
            }}
          >
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs justify-start font-normal"
                disabled={isBusy || !canEdit}
              >
                <Languages className="h-3 w-3 mr-1.5" />
                Translate to
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-52 p-1">
              <div className="p-1 pb-0">
                <Input
                  autoFocus
                  placeholder="Search language…"
                  value={langSearch}
                  onChange={(e) => setLangSearch(e.target.value)}
                  className="h-7 text-xs"
                />
              </div>
              <div className="max-h-56 overflow-y-auto mt-1">
                {LANGUAGES.filter((l) =>
                  l.toLowerCase().includes(langSearch.toLowerCase()),
                ).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted"
                    onClick={() => {
                      setLangOpen(false);
                      setLangSearch("");
                      run("translate", { targetLanguage: lang });
                    }}
                  >
                    {lang}
                  </button>
                ))}
                {LANGUAGES.filter((l) =>
                  l.toLowerCase().includes(langSearch.toLowerCase()),
                ).length === 0 && (
                  <p className="px-2 py-3 text-xs text-muted-foreground text-center">
                    No language found
                  </p>
                )}
              </div>
            </PopoverContent>
          </Popover>

          <Separator className="my-1" />

          {/* Custom prompt */}
          <div>
            <div className="px-2 py-1 text-[11px]  text-muted-foreground">Custom instruction</div>

            <div className="flex items-center gap-1">
              <Input
                placeholder="Type, or press the microphone and speak"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customPrompt.trim() && !isBusy) {
                    e.preventDefault();
                    run("custom", { customPrompt });
                  }
                }}
                className="h-9 text-xs"
                disabled={isBusy}
              />
              {/* Speak the instruction instead of typing it — the language is
               * detected, so Bengali, Hindi or English all work. */}
              <DictationButton
                variant="outline"
                size="icon"
                disabled={isBusy}
                title="Speak your instruction"
                onText={(t) => setCustomPrompt((prev) => (prev.trim() ? `${prev.trim()} ${t}` : t))}
              />

              {/* The ready-made instructions. Chips above the box had room for
               * a handful; as a menu the whole library fits, with the entries
               * that match this conversation at the top. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="shrink-0"
                    disabled={isBusy}
                    aria-label="Suggested instructions"
                    title="Suggested instructions"
                  >
                    <Lightbulb className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
                  {hints.length > 0 && (
                    <>
                      <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                        Suggested for this conversation
                      </DropdownMenuLabel>
                      {hints.map((h) => (
                        <DropdownMenuItem
                          key={`ctx-${h.label}`}
                          className="text-xs"
                          onSelect={() => {
                            setCustomPrompt(h.instruction);
                            run("custom", { customPrompt: h.instruction });
                          }}
                        >
                          {h.label}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {GENERAL_HINTS.map((group) => (
                    <div key={group.group}>
                      <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                        {group.group}
                      </DropdownMenuLabel>
                      {group.hints.map((h) => (
                        <DropdownMenuItem
                          key={h.label}
                          className="text-xs"
                          onSelect={() => {
                            setCustomPrompt(h.instruction);
                            run("custom", { customPrompt: h.instruction });
                          }}
                        >
                          {h.label}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                size="icon"
                className="shrink-0"
                disabled={isBusy || !customPrompt.trim()}
                onClick={() => run("custom", { customPrompt })}
                aria-label="Run custom prompt"
              >
                {isBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ArrowRight className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        </div>

        <div className="px-3 py-1.5 bg-muted/30 border-t border-border flex items-center gap-1.5">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          <span className="text-[11px] text-muted-foreground">
            Uses conversation history, CRM, and business context
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
