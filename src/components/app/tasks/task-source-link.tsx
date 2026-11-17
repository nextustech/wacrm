/**
 * "Created from chat" link shown on a task's detail/edit dialog.
 *
 * Tasks can be opened straight from the inbox, and until now nothing on the
 * task said which conversation it came from — so whoever picked the task up
 * later had to search the inbox by hand. This resolves the stored
 * conversation id into a readable line (who, which channel, what was last
 * said) and a one-click link back to that thread.
 *
 * Works for both task systems: project tasks store `conversation_id`, CRM
 * tasks store `entity_type: "conversation"` with the id in `entity_id`.
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type SourceContact = {
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
};

type SourceConversation = {
  id: string;
  subject: string | null;
  channel: string | null;
  last_message_preview: string | null;
  contact: SourceContact | SourceContact[] | null;
};

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  sms: "SMS",
  webchat: "Live chat",
  instagram: "Instagram",
  messenger: "Messenger",
  telegram: "Telegram",
  facebook: "Facebook",
  voice: "Voice",
};

/** Supabase returns an embedded row as an object or a one-item array. */
const firstContact = (value: SourceConversation["contact"]): SourceContact | null =>
  Array.isArray(value) ? (value[0] ?? null) : value;

function contactName(contact: SourceContact | null): string {
  if (!contact) return "Unknown contact";
  const full = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
  return contact.display_name?.trim() || full || contact.phone || contact.email || "Unknown contact";
}

export function useTaskSourceConversation(conversationId: string | null | undefined) {
  return useQuery({
    queryKey: ["task-source-conversation", conversationId],
    enabled: !!conversationId,
    staleTime: 60_000,
    queryFn: async (): Promise<SourceConversation | null> => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          "id, subject, channel, last_message_preview, contact:contacts!conversations_contact_id_fkey(display_name, first_name, last_name, phone, email)",
        )
        .eq("id", conversationId as string)
        .is("deleted_at", null)
        .maybeSingle();
      // A deleted or out-of-scope chat is not an error here — the task simply
      // loses its link, and the caller renders that case.
      if (error) return null;
      return (data as unknown as SourceConversation) ?? null;
    },
  });
}

export function TaskSourceLink({
  conversationId,
  className,
}: {
  conversationId: string | null | undefined;
  className?: string;
}) {
  const { data, isLoading } = useTaskSourceConversation(conversationId);
  if (!conversationId) return null;

  const contact = firstContact(data?.contact ?? null);
  const channel = data?.channel ? (CHANNEL_LABELS[data.channel] ?? data.channel) : null;
  const preview = data?.subject?.trim() || data?.last_message_preview?.trim() || "";

  return (
    <div
      className={`flex items-start gap-3 rounded-control border bg-muted/40 p-3 ${className ?? ""}`}
    >
      <MessageSquare className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">Created from chat</p>
        {isLoading ? (
          <Skeleton className="mt-1 h-4 w-40" />
        ) : data ? (
          <>
            <p className="truncate text-sm font-medium">
              {contactName(contact)}
              {channel && (
                <span className="font-normal text-muted-foreground"> · {channel}</span>
              )}
            </p>
            {preview && (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{preview}</p>
            )}
          </>
        ) : (
          <p className="mt-0.5 text-sm text-muted-foreground">
            That conversation is no longer available.
          </p>
        )}
      </div>
      {data && (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link to="/inbox" search={{ conversationId }}>
            Open chat
            <ArrowUpRight className="ml-1 size-3.5" />
          </Link>
        </Button>
      )}
    </div>
  );
}
