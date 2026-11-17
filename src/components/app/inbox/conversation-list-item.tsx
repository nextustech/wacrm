import { Fragment, useEffect, useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { useZonedDateFormatter } from "@/hooks/use-timezone";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { LucideIcon } from "lucide-react";
import {
  CheckCheck,
  Pin,
  Star,
  AlertCircle,
  ListTodo,
  MoreHorizontal,
  MailOpen,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  RotateCcw,
  MessageSquare,
  MoreVertical,
  Info,
  UserCheck,
  Tag,
  Link2,
  Download,
  Trash2,
  Plus,
} from "lucide-react";
import type { ConversationRow } from "@/hooks/use-conversations";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  resolveContactDisplayName,
  resolveContactInitials,
  resolveContactPhoneSubtitle,
} from "@/lib/inbox/contact-display";
import { cn } from "@/lib/utils";
import { ChannelIcon } from "./channel-icon";
import { LabelChip } from "./label-manager";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ConversationListAction = "open" | "unread" | "star" | "pin" | "resolve" | "archive";

type Props = {
  conversation: ConversationRow;
  isActive?: boolean;
  /** Connected account this thread arrived on (mailbox / number / handle). */
  accountLabel?: string;
  onSelect: (id: string) => void;
  onAction?: (conversation: ConversationRow, action: ConversationListAction) => void;
  typingUserIds?: string[];
  /** Open (not completed or cancelled) tasks linked to this conversation. */
  openTaskCount?: number;
  /** Workspace members, for the per-item "Assign" submenu. */
  members?: Array<{ user_id: string; display_name: string | null; email: string | null }>;
  /** Workspace labels, for the per-item "Label" submenu. */
  labels?: Array<{ id: string; name: string; color: string | null }>;
  /** Quick actions that used to require bulk-select — now available on a single item. */
  onAssign?: (conversationId: string, userId: string | null) => void;
  onApplyLabels?: (conversationId: string, labelIds: string[]) => void;
  /** Opens the label manager, so a new label can be made without leaving the inbox. */
  onManageLabels?: () => void;
  onLinkContact?: (conversationId: string) => void;
  onExport?: (conversationId: string) => void;
  onDelete?: (conversationId: string) => void;
};

const priorityStyles: Record<string, string> = {
  urgent: "text-red-500",
  high: "text-orange-500",
  normal: "text-transparent",
  low: "text-transparent",
};

export function ConversationListItem({
  conversation: c,
  isActive,
  accountLabel,
  onSelect,
  onAction,
  typingUserIds,
  openTaskCount = 0,
  members,
  labels,
  onAssign,
  onApplyLabels,
  onManageLabels,
  onLinkContact,
  onExport,
  onDelete,
}: Props) {
  // The labels this conversation already carries, as the source of truth for
  // the submenu's checkboxes. Keyed by the ids so a realtime update to the
  // conversation re-seeds the selection instead of leaving it stale.
  const zonedDate = useZonedDateFormatter();
  const assignedLabelIds = useMemo(() => (c.labels ?? []).map((l) => l.id), [c.labels]);
  const [pickedLabelIds, setPickedLabelIds] = useState<Set<string>>(
    () => new Set(assignedLabelIds),
  );
  useEffect(() => {
    setPickedLabelIds(new Set(assignedLabelIds));
  }, [assignedLabelIds]);
  const labelSelectionChanged =
    pickedLabelIds.size !== assignedLabelIds.length ||
    assignedLabelIds.some((id) => !pickedLabelIds.has(id));

  const name = resolveContactDisplayName(c.contact);
  const initials = resolveContactInitials(c.contact);
  const phoneSubtitle = resolveContactPhoneSubtitle(c.contact);
  const unread = c.unread_count > 0;
  const pinnedMeta = (c.metadata ?? {}) as Record<string, unknown>;
  const starred = pinnedMeta.starred === true || pinnedMeta.starred === "true";
  const pinned = pinnedMeta.pinned === true || pinnedMeta.pinned === "true";
  // Set only by "Mark as unsolved". A thread nobody has acted on carries no
  // marker, so the default inbox stays unmarked.
  const unsolved = pinnedMeta.unsolved === true || pinnedMeta.unsolved === "true";
  // "bot" is ours too — an automated reply gets the same receipt ticks.
  const outbound = c.last_message_from === "agent" || c.last_message_from === "bot";
  const hasMetaRow = (c.labels?.length ?? 0) > 0 || !!c.assignee || unread;
  const online =
    c.contact?.last_seen_at &&
    Date.now() - new Date(c.contact.last_seen_at).getTime() < 5 * 60 * 1000;
  const isTyping = (typingUserIds?.length ?? 0) > 0;
  const preview = isTyping ? "typing" : (c.last_message_preview ?? "No messages yet");
  // "5 minutes ago" reads at a glance; the exact stamp lives in the info
  // popover for when the precise moment matters.
  const lastMessageAgo = c.last_message_at
    ? formatDistanceToNowStrict(new Date(c.last_message_at), { addSuffix: true })
    : "";
  const lastMessageStamp = c.last_message_at
    ? zonedDate(c.last_message_at, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const actions: Array<{ id: ConversationListAction; label: string; icon: LucideIcon }> = [
    { id: "open", label: "Open conversation", icon: MessageSquare },
    ...(!unread ? [{ id: "unread" as const, label: "Mark as unread", icon: MailOpen }] : []),
    { id: "star", label: starred ? "Remove star" : "Star", icon: Star },
    { id: "pin", label: pinned ? "Unpin" : "Pin to top", icon: Pin },
    {
      id: "resolve",
      label: c.status === "resolved" ? "Mark as unsolved" : "Mark as resolved",
      icon: c.status === "resolved" ? RotateCcw : CheckCircle2,
    },
    {
      id: "archive",
      label: c.is_archived ? "Unarchive" : "Archive",
      icon: c.is_archived ? ArchiveRestore : Archive,
    },
  ];
  const runAction = (action: ConversationListAction) => {
    if (action === "open") onSelect(c.id);
    else onAction?.(c, action);
  };

  return (
    <div className="relative w-full min-w-0">
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        aria-current={isActive ? "true" : undefined}
        className={cn(
          "w-full min-w-0 m-0 text-left flex items-start gap-3 pl-4 pr-4 py-4 rounded-none transition-colors relative overflow-hidden sm:gap-4 sm:pl-4 sm:pr-4 sm:py-4",
          "border-b border-border bg-transparent hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive && "bg-muted/90",
        )}
      >
        <div className="relative shrink-0">
          <Avatar className="h-9 w-9 sm:h-10 sm:w-10">
            <AvatarImage src={c.contact?.avatar_url ?? undefined} alt={name} />
            <AvatarFallback className="text-xs font-medium">{initials || "?"}</AvatarFallback>
          </Avatar>
          {online && (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-green-500 ring-2 ring-background"
              aria-label="Online"
            />
          )}
          <ChannelIcon
            channel={c.channel}
            boxed
            className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full ring-2 ring-background bg-card"
            iconClassName="h-full w-full"
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 pr-32 sm:gap-2">
            {/* Both size to their text, so the subtitle sits right beside the
                name with no gap. The lopsided shrink factors mean a cramped
                row eats into the subtitle long before the name. */}
            <span
              className={cn(
                "min-w-0 shrink-[0.25] truncate text-base sm:text-sm",
                unread ? "font-semibold text-foreground" : "font-medium text-foreground/90",
              )}
            >
              {name}
            </span>
            {phoneSubtitle && (
              <span className="hidden sm:inline min-w-0 shrink-[4] truncate max-w-[140px] text-[11px] text-muted-foreground">
                {phoneSubtitle}
              </span>
            )}

            {pinned && <Pin className="h-3 w-3 text-primary shrink-0" />}
            {starred && <Star className="h-3 w-3 fill-yellow-400 text-yellow-400 shrink-0" />}
            {c.priority === "urgent" && <AlertCircle className="h-3 w-3 text-red-500 shrink-0" />}
            {openTaskCount > 0 && (
              <span
                title={`${openTaskCount} open task${openTaskCount > 1 ? "s" : ""}`}
                className="inline-flex items-center gap-0.5 rounded-control bg-primary/10 px-1 text-[11px] font-medium text-primary shrink-0"
              >
                <ListTodo className="h-2.5 w-2.5" />
                {openTaskCount}
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-1 mt-1">
            {outbound && c.last_message_status !== "failed" && (
              // Same read/delivered distinction the thread bubble makes: blue
              // once the contact has seen it, grey until then.
              <CheckCheck
                className={cn(
                  "h-3 w-3 shrink-0",
                  c.last_message_status === "read" ? "text-sky-500" : "text-muted-foreground",
                )}
              />
            )}
            {outbound && c.last_message_status === "failed" && (
              <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
            )}
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                isTyping && "text-primary italic",
                !isTyping && unread ? "text-foreground/90 font-medium" : "text-muted-foreground",
              )}
            >
              {preview}
            </p>
          </div>

          {/* Nothing to show here on a plain thread — the row is skipped so the
            * item does not end in an empty strip. */}
          {hasMetaRow && (
          <div className="flex flex-wrap items-center gap-1 sm:gap-1.5 mt-1.5">
            {c.labels?.slice(0, 3).map((label) => (
              <span
                key={label.id}
                className="inline-flex max-w-[90px] items-center truncate text-[11px] sm:text-[11px] px-1.5 py-0.25 rounded font-medium"
                style={{
                  backgroundColor: label.color ? `${label.color}20` : undefined,
                  color: label.color ?? undefined,
                  border: label.color ? `1px solid ${label.color}40` : undefined,
                }}
              >
                {label.name}
              </span>
            ))}
            {c.assignee && (
              <span className="flex shrink-0 items-center gap-1 text-[11px] sm:text-[11px] text-muted-foreground">
                <Avatar className="h-4 w-4">
                  <AvatarImage src={c.assignee.avatar_url ?? undefined} />
                  <AvatarFallback className="text-[8px]">
                    {(c.assignee.display_name ?? "?")[0]}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline truncate max-w-[80px]">
                  {c.assignee.display_name}
                </span>
              </span>
            )}
            {unread && (
              <span className="ml-auto shrink-0 min-w-[18px] h-[18px] px-1.5 grid place-items-center rounded-control bg-primary text-primary-foreground text-[11px] sm:text-[11px] font-semibold ">
                {c.unread_count > 99 ? "99+" : c.unread_count}
              </span>
            )}
          </div>
          )}

        </div>
      </button>
      {onAction && (
        <div className="absolute right-4 top-3 flex items-center gap-1 text-muted-foreground sm:top-4">
          {/* Only a thread explicitly marked unsolved carries a dot. */}
          {unsolved && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
              title="Unsolved"
              aria-label="Unsolved"
            />
          )}

          {lastMessageAgo && (
            <span className="shrink-0 whitespace-nowrap text-[11px]">{lastMessageAgo}</span>
          )}
          {/* Everything that used to crowd the row — which account it landed
              on, the exact timestamp — one hover away instead. */}
          <HoverCard openDelay={120} closeDelay={80}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                aria-label={`Details for ${name}`}
                className="grid h-4 w-4 shrink-0 place-items-center rounded-control cursor-pointer hover:text-foreground"
              >
                <Info className="h-3 w-3" />
              </button>
            </HoverCardTrigger>
            <HoverCardContent align="end" side="bottom" className="w-64 p-3 text-xs">
              <dl className="space-y-1.5">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">Channel</dt>
                  <dd className="min-w-0 flex-1 truncate capitalize">{c.channel}</dd>
                </div>
                {accountLabel && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">Received on</dt>
                    <dd className="min-w-0 flex-1 truncate">{accountLabel}</dd>
                  </div>
                )}
                {phoneSubtitle && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">Contact</dt>
                    <dd className="min-w-0 flex-1 truncate">{phoneSubtitle}</dd>
                  </div>
                )}
                {lastMessageStamp && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">Last message</dt>
                    <dd className="min-w-0 flex-1">{lastMessageStamp}</dd>
                  </div>
                )}
                {c.assignee?.display_name && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">Assigned to</dt>
                    <dd className="min-w-0 flex-1 truncate">{c.assignee.display_name}</dd>
                  </div>
                )}
              </dl>
            </HoverCardContent>
          </HoverCard>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${name}`}
                className="grid h-4 w-4 shrink-0 place-items-center rounded-control cursor-pointer"
              >
                <MoreVertical className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {actions.map(({ id, label, icon: Icon }, index) => (
                <Fragment key={id}>
                  {index === 1 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => runAction(id)} className="gap-2">
                    <Icon className="h-4 w-4" />
                    {label}
                  </DropdownMenuItem>
                </Fragment>
              ))}
              {(onAssign || onApplyLabels || onLinkContact || onExport) && (
                <>
                  <DropdownMenuSeparator />
                  {onAssign && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2">
                        <UserCheck className="h-4 w-4" />
                        Assign
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-48 max-h-64 overflow-y-auto">
                        <DropdownMenuItem onSelect={() => onAssign(c.id, null)}>
                          Unassign
                        </DropdownMenuItem>
                        {(members ?? []).map((m) => (
                          <DropdownMenuItem
                            key={m.user_id}
                            onSelect={() => onAssign(c.id, m.user_id)}
                          >
                            {m.display_name ?? m.email ?? "Unnamed"}
                          </DropdownMenuItem>
                        ))}
                        {(members ?? []).length === 0 && (
                          <p className="px-2 py-3 text-xs text-muted-foreground text-center">
                            No members
                          </p>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  {onApplyLabels && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2">
                        <Tag className="h-4 w-4" />
                        Label
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-56">
                        <div className="max-h-56 overflow-y-auto">
                          {(labels ?? []).map((l) => (
                            <DropdownMenuCheckboxItem
                              key={l.id}
                              checked={pickedLabelIds.has(l.id)}
                              onSelect={(e) => e.preventDefault()}
                              onCheckedChange={(v) =>
                                setPickedLabelIds((s) => {
                                  const n = new Set(s);
                                  if (v) n.add(l.id);
                                  else n.delete(l.id);
                                  return n;
                                })
                              }
                            >
                              <LabelChip label={l} />
                            </DropdownMenuCheckboxItem>
                          ))}
                          {(labels ?? []).length === 0 && (
                            <p className="px-2 py-3 text-xs text-muted-foreground text-center">
                              No labels yet.
                            </p>
                          )}
                        </div>
                        <DropdownMenuSeparator />
                        {onManageLabels && (
                          <DropdownMenuItem onSelect={() => onManageLabels()} className="gap-2">
                            <Plus className="h-4 w-4" />
                            New label
                          </DropdownMenuItem>
                        )}
                        {(labels ?? []).length > 0 && (
                          <div className="p-2">
                            <Button
                              size="sm"
                              className="w-full"
                              disabled={!labelSelectionChanged}
                              onClick={() => onApplyLabels(c.id, Array.from(pickedLabelIds))}
                            >
                              {labelSelectionChanged ? "Save labels" : "No changes"}
                            </Button>
                          </div>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  {onLinkContact && (
                    <DropdownMenuItem onSelect={() => onLinkContact(c.id)} className="gap-2">
                      <Link2 className="h-4 w-4" />
                      Link contact
                    </DropdownMenuItem>
                  )}
                  {onExport && (
                    <DropdownMenuItem onSelect={() => onExport(c.id)} className="gap-2">
                      <Download className="h-4 w-4" />
                      Export
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <DropdownMenuItem
                      onSelect={() => onDelete(c.id)}
                      className="gap-2 text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

export function ConversationListItemSkeleton() {
  return (
    <div className="flex items-start gap-3 mx-2 my-1.5 px-3 py-3 rounded-control bg-muted/35 animate-pulse">
      <div className="h-8 w-8 rounded-full bg-muted shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-1/3 bg-muted rounded" />
        <div className="h-3 w-4/5 bg-muted rounded" />
        <div className="h-2 w-1/4 bg-muted rounded" />
      </div>
    </div>
  );
}
