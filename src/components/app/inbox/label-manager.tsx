import { useState } from "react";
import { Loader2, Plus, Tag, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useDeleteLabel,
  useLabels,
  useUpsertLabel,
  type Label as LabelRow,
} from "@/hooks/use-inbox-organization";

const COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#64748b",
];

/** Returns the canonical `#rrggbb` form, or null when the value isn't a hex colour. */
function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  // `<input type="color">` only emits 6-digit hex, but a typed 3-digit
  // shorthand is a reasonable thing for someone to write.
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

const isSameColor = (a: string, b: string) => normalizeHex(a) === normalizeHex(b);

export function LabelManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: labels = [] } = useLabels();
  const upsert = useUpsertLabel();
  const del = useDeleteLabel();
  const [draft, setDraft] = useState<{ name: string; color: string }>({
    name: "",
    color: COLORS[5],
  });
  const [editingId, setEditingId] = useState<string | null>(null);

  const startEdit = (l: LabelRow) => {
    setEditingId(l.id);
    setDraft({ name: l.name, color: l.color ?? COLORS[5] });
  };
  const clear = () => {
    setEditingId(null);
    setDraft({ name: "", color: COLORS[5] });
  };
  const color = normalizeHex(draft.color);
  const canSubmit = !!draft.name.trim() && !!color;

  const submit = async () => {
    if (!canSubmit) return;
    await upsert.mutateAsync({
      id: editingId ?? undefined,
      name: draft.name.trim(),
      color: color!,
    });
    clear();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4" /> Manage labels
          </DialogTitle>
          <DialogDescription>
            Create color-coded labels to organize conversations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-control border border-border p-3 space-y-2">
            <Input
              placeholder="Label name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <div className="flex items-center gap-1.5 flex-wrap">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Pick color ${c}`}
                  onClick={() => setDraft((d) => ({ ...d, color: c }))}
                  className={cn(
                    "h-10 w-10 rounded-full border-2 transition-transform",
                    isSameColor(draft.color, c)
                      ? "border-foreground scale-110"
                      : "border-transparent",
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            {/* The presets are shortcuts, not the whole range — any colour is
             * reachable through the picker or by typing a hex value. */}
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Choose a custom colour"
                value={normalizeHex(draft.color) ?? "#64748b"}
                onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                className="h-9 w-12 shrink-0 cursor-pointer rounded-control border border-border bg-background p-1"
              />
              <Input
                aria-label="Colour hex value"
                value={draft.color}
                spellCheck={false}
                maxLength={7}
                onChange={(e) => {
                  const next = e.target.value.trim();
                  setDraft((d) => ({ ...d, color: next.startsWith("#") ? next : `#${next}` }));
                }}
                placeholder="#64748b"
                className={cn("h-9 font-mono", !normalizeHex(draft.color) && "border-destructive")}
              />
              <span
                className="h-9 w-9 shrink-0 rounded-control border border-border"
                style={{ backgroundColor: normalizeHex(draft.color) ?? "transparent" }}
              />
            </div>
            {!normalizeHex(draft.color) && (
              <p className="text-xs text-destructive">Enter a hex colour like #3b82f6.</p>
            )}
            <div className="flex justify-end gap-2">
              {editingId && (
                <Button variant="ghost" size="sm" onClick={clear}>
                  <X className="h-3.5 w-3.5" /> Cancel
                </Button>
              )}
              <Button size="sm" onClick={submit} disabled={upsert.isPending || !canSubmit}>
                {upsert.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {editingId ? "Save" : "Create"}
              </Button>
            </div>
          </div>

          <ScrollArea className="max-h-80">
            <div className="space-y-1">
              {labels.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-muted group"
                >
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: l.color ?? "#64748b" }}
                  />
                  <button
                    type="button"
                    className="flex-1 text-left text-sm truncate"
                    onClick={() => startEdit(l)}
                  >
                    {l.name}
                  </button>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {l.usage_count === 1 ? "1 chat" : `${l.usage_count} chats`}
                  </span>
                  {l.is_system && (
                    <Badge variant="outline" className="text-[11px] h-4 px-1">
                      System
                    </Badge>
                  )}
                  {!l.is_system && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => del.mutate(l.id)}
                      aria-label="Delete label"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
              {labels.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">
                  No labels yet. Create your first one above.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LabelChip({ label }: { label: Pick<LabelRow, "name" | "color"> }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-control px-2 py-0 text-[11px] font-medium border"
      style={{
        borderColor: (label.color ?? "#64748b") + "40",
        backgroundColor: (label.color ?? "#64748b") + "18",
        color: label.color ?? "#64748b",
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: label.color ?? "#64748b" }}
      />
      {label.name}
    </span>
  );
}
