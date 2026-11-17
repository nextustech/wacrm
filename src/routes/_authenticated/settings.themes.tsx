import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listPublicThemes,
  activateTheme,
  listMyThemes,
  saveMyTheme,
  activateMyTheme,
  deleteMyTheme,
  resetWorkspaceTheme,
} from "@/lib/themes/themes.functions";
import { readActiveWorkspaceId, subscribeActiveTenant } from "@/lib/tenant/active-tenant";
import {
  ACCENT_PRESETS,
  ACCESSIBLE_ACCENT_PRESETS,
  isValidAccent,
  useTenantAccent,
  accentStrong,
  evaluateAccentContrast,
  suggestAccentPairings,
} from "@/lib/themes/tenant-accent";
import { DEFAULT_ACCENT } from "@/lib/themes/accent-color";
import type { ThemeConfig } from "@/lib/themes/theme-config-fields";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  Trash2,
  Plus,
  Store,
  Sparkles,
  Palette,
  Type,
  LayoutDashboard,
  Moon,
  Sun,
  ImageIcon,
  LogIn,
  Mail,
  ShieldAlert,
  AlertTriangle,
  X,
} from "lucide-react";
import {
  Field,
  ColorField,
  GoogleFontField,
  FontSizeField,
} from "@/components/settings/white-label-fields";
import { ImageDropUpload } from "@/components/branding/image-drop-upload";
import type { BrandingScope } from "@/lib/branding/upload";

export const Route = createFileRoute("/_authenticated/settings/themes")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/white-label" });
  },
  staticData: { breadcrumb: "Themes" },
  head: () => ({
    meta: [
      { title: "Themes & Accent — Settings" },
      {
        name: "description",
        content:
          "Create, edit, and activate workspace themes — colors, typography, layout, and brand touchpoints.",
      },
    ],
  }),
  component: ThemesSettings,
});

type SectionKey =
  | "brand-colors"
  | "other-colors"
  | "typography"
  | "layout"
  | "modes"
  | "identity"
  | "login"
  | "email";

const VISUAL_DESIGN: { key: SectionKey; label: string; icon: typeof Palette }[] = [
  { key: "brand-colors", label: "Brand colors", icon: Palette },
  { key: "other-colors", label: "Other colors", icon: Palette },
  { key: "typography", label: "Typography", icon: Type },
  { key: "layout", label: "Layout", icon: LayoutDashboard },
  { key: "modes", label: "Default mode", icon: Moon },
];

const BRAND_TOUCHPOINTS: { key: SectionKey; label: string; icon: typeof ImageIcon }[] = [
  { key: "identity", label: "Identity & logos", icon: ImageIcon },
  { key: "login", label: "Login page", icon: LogIn },
  { key: "email", label: "Email", icon: Mail },
];

type MyTheme = {
  id: string;
  name: string;
  description: string | null;
  config: ThemeConfig;
  created_at?: string;
};

export function ThemesSettings() {
  const qc = useQueryClient();
  const workspaceId = useSyncExternalStore(
    subscribeActiveTenant,
    readActiveWorkspaceId,
    () => null,
  );
  const brandScope: BrandingScope = workspaceId
    ? { kind: "workspace", workspaceId }
    : { kind: "platform" };

  const myThemesQ = useQuery({
    queryKey: ["my-themes", workspaceId],
    queryFn: () => listMyThemes({ data: { workspaceId } }),
    enabled: Boolean(workspaceId),
  });
  const marketplaceQ = useQuery({ queryKey: ["themes"], queryFn: () => listPublicThemes({}) });

  const myThemes = (myThemesQ.data?.themes ?? []) as MyTheme[];
  const activeThemeId = myThemesQ.data?.activeThemeId ?? null;

  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [section, setSection] = useState<SectionKey>("brand-colors");
  const [form, setForm] = useState<ThemeConfig>({});
  const [nameDraft, setNameDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  // A pending destructive/discarding action (losing edits, deleting a theme)
  // routed through a shadcn AlertDialog instead of the native window.confirm().
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  // Pick an initial selection exactly once, when the list first arrives —
  // after that, an intentional "new theme" (selectedThemeId = null) must stick.
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current || myThemes.length === 0) return;
    initRef.current = true;
    setSelectedThemeId(activeThemeId ?? myThemes[0].id);
  }, [myThemes, activeThemeId]);

  const selectedTheme = myThemes.find((t) => t.id === selectedThemeId) ?? null;

  useEffect(() => {
    setForm(selectedTheme ? { ...(selectedTheme.config ?? {}) } : {});
    setNameDraft(selectedTheme?.name ?? "");
    setDescDraft(selectedTheme?.description ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThemeId]);

  const set = (k: keyof ThemeConfig, v: string | number | null) =>
    setForm((f) => ({ ...f, [k]: v }));

  const dirty = useMemo(() => {
    if (!selectedTheme) return Boolean(nameDraft.trim()) || Object.keys(form).length > 0;
    if (nameDraft !== selectedTheme.name) return true;
    if ((descDraft || "") !== (selectedTheme.description || "")) return true;
    return JSON.stringify(form) !== JSON.stringify(selectedTheme.config ?? {});
  }, [form, nameDraft, descDraft, selectedTheme]);

  function selectTheme(id: string | null) {
    if (dirty) {
      setConfirmPrompt({
        title: "Discard unsaved changes?",
        description: `"${nameDraft.trim() || "This theme"}" has edits that haven't been saved. Switching now will discard them.`,
        confirmLabel: "Discard changes",
        onConfirm: () => setSelectedThemeId(id),
      });
      return;
    }
    setSelectedThemeId(id);
  }

  const save = useMutation({
    mutationFn: () =>
      saveMyTheme({
        data: {
          themeId: selectedThemeId,
          workspaceId,
          name: nameDraft.trim() || "Untitled theme",
          description: descDraft.trim() || null,
          config: form,
        },
      }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["my-themes"] });
      setSelectedThemeId(res.themeId);
      toast.success(`"${nameDraft.trim() || "Theme"}" saved`);
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save this theme"),
  });

  // Activate always reflects your latest edits: it saves first if there's
  // anything unsaved, then pushes that config live. This is the one button
  // that actually changes what visitors see — "Save theme" never does.
  const activate = useMutation({
    mutationFn: async () => {
      let id = selectedThemeId;
      if (dirty || !id) {
        const res = await saveMyTheme({
          data: {
            themeId: id,
            workspaceId,
            name: nameDraft.trim() || "Untitled theme",
            description: descDraft.trim() || null,
            config: form,
          },
        });
        id = res.themeId;
      }
      await activateMyTheme({ data: { themeId: id!, workspaceId } });
      return id!;
    },
    onSuccess: async (id) => {
      await qc.invalidateQueries({ queryKey: ["my-themes"] });
      await qc.invalidateQueries({ queryKey: ["active-theme"] });
      await qc.invalidateQueries({ queryKey: ["white-label"] });
      setSelectedThemeId(id);
      toast.success(`"${nameDraft.trim() || "Theme"}" is now live`);
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not activate this theme"),
  });

  const remove = useMutation({
    mutationFn: () => deleteMyTheme({ data: { themeId: selectedThemeId!, workspaceId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["my-themes"] });
      setSelectedThemeId(null);
      toast.success("Theme deleted");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not delete this theme"),
  });

  const activateMarketplace = useMutation({
    mutationFn: (themeId: string) => activateTheme({ data: { themeId, workspaceId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["my-themes"] });
      await qc.invalidateQueries({ queryKey: ["active-theme"] });
      await qc.invalidateQueries({ queryKey: ["white-label"] });
      toast.success("Theme activated");
      setMarketplaceOpen(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Activation failed"),
  });

  const useDefaultLook = useMutation({
    mutationFn: () => resetWorkspaceTheme({ data: { workspaceId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["my-themes"] });
      await qc.invalidateQueries({ queryKey: ["active-theme"] });
      await qc.invalidateQueries({ queryKey: ["white-label"] });
      toast.success("Back to the plain default look");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not reset the theme"),
  });

  const doStartNewTheme = () => {
    setSelectedThemeId(null);
    setForm({});
    setNameDraft("New theme");
    setDescDraft("");
    setSection("brand-colors");
  };

  const startNewTheme = () => {
    if (dirty) {
      setConfirmPrompt({
        title: "Discard unsaved changes?",
        description: `"${nameDraft.trim() || "This theme"}" has edits that haven't been saved. Starting a new theme will discard them.`,
        confirmLabel: "Discard changes",
        onConfirm: doStartNewTheme,
      });
      return;
    }
    doStartNewTheme();
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* Left sidebar — theme switcher + merged Visual design / Brand touchpoints nav */}
      <aside className="w-full shrink-0 space-y-4 lg:w-64">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">My themes</CardTitle>
            <CardDescription className="text-xs">
              Create as many as you like — only one is ever live at a time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {myThemes.map((t) => {
              const primary = (t.config?.primary_color as string) || "#e5e7eb";
              const accent = (t.config?.accent_color as string) || "#d1d5db";
              const bg = (t.config?.background_color as string) || "#f3f4f6";
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectTheme(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") selectTheme(t.id);
                  }}
                  className={`block w-full overflow-hidden rounded-control border text-left transition cursor-pointer ${
                    t.id === selectedThemeId
                      ? "border-primary ring-1 ring-primary"
                      : "border-border hover:border-primary/40"
                  }`}
                >
                  {/* Proportioned color-palette preview — primary dominant, accent and background as bands. */}
                  <div className="flex h-[220px] w-full flex-col" style={{ background: bg }}>
                    <div className="h-[60%] w-full" style={{ background: primary }} />
                    <div className="h-[25%] w-full" style={{ background: accent }} />
                    <div className="h-[15%] w-full border-t" style={{ background: bg }} />
                  </div>
                  <div className="flex items-center gap-1.5 border-t px-2.5 py-2">
                    <span className="truncate flex-1 text-sm font-medium">{t.name}</span>
                    {t.id === activeThemeId && (
                      <Badge className="shrink-0 gap-1 text-[10px]">
                        <CheckCircle2 className="size-3" />
                        Live
                      </Badge>
                    )}
                    {t.id === selectedThemeId && t.id !== activeThemeId && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        Editing
                      </Badge>
                    )}
                    {t.id === activeThemeId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0"
                        title="Deactivate — back to default look"
                        onClick={(e) => {
                          e.stopPropagation();
                          useDefaultLook.mutate();
                        }}
                        disabled={useDefaultLook.isPending}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                      title="Delete theme"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (t.id === activeThemeId) {
                          toast.error("Deactivate this theme before deleting it");
                          return;
                        }
                        setConfirmPrompt({
                          title: "Delete this theme?",
                          description: `"${t.name}" will be permanently deleted. This can't be undone.`,
                          confirmLabel: "Delete theme",
                          onConfirm: () => {
                            deleteMyTheme({ data: { themeId: t.id, workspaceId } }).then(
                              async () => {
                                await qc.invalidateQueries({ queryKey: ["my-themes"] });
                                if (selectedThemeId === t.id) setSelectedThemeId(null);
                                toast.success("Theme deleted");
                              },
                              (e: any) => toast.error(e?.message ?? "Could not delete this theme"),
                            );
                          },
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
            {myThemes.length === 0 && !selectedTheme && (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                No themes yet — editing a new one below.
              </p>
            )}
            <Button variant="outline" size="sm" className="w-full" onClick={startNewTheme}>
              <Plus className="size-4 mr-2" />
              New theme
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setMarketplaceOpen(true)}
            >
              <Store className="size-4 mr-2" />
              Browse Themes
            </Button>
            {activeThemeId && (
              <Button
                variant="outline"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => useDefaultLook.mutate()}
                disabled={useDefaultLook.isPending}
              >
                {useDefaultLook.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
                Use default look instead
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Visual design</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-0">
            {VISUAL_DESIGN.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setSection(key)}
                className={`flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm transition ${
                  section === key ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/60"
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Brand touchpoints</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-0">
            {BRAND_TOUCHPOINTS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setSection(key)}
                className={`flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm transition ${
                  section === key ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/60"
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </CardContent>
        </Card>
      </aside>

      {/* Right content — editing header + the selected section's fields */}
      <div className="min-w-0 flex-1 space-y-4">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-[220px] flex-1">
              <p className="text-xs text-muted-foreground">
                {selectedThemeId ? "Editing theme" : "Editing new theme (not saved yet)"}
              </p>
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Theme name"
                disabled={!workspaceId}
                className="mt-0.5 h-9 text-base font-semibold"
              />
            </div>
            {selectedThemeId && selectedThemeId === activeThemeId && (
              <Badge className="gap-1">
                <CheckCircle2 className="size-3" />
                Live
              </Badge>
            )}
            {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
            <div className="ml-auto flex flex-wrap gap-2">
              {selectedThemeId && selectedThemeId !== activeThemeId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setConfirmPrompt({
                      title: "Delete this theme?",
                      description: `"${selectedTheme?.name ?? "This theme"}" will be permanently deleted. This can't be undone.`,
                      confirmLabel: "Delete theme",
                      onConfirm: () => remove.mutate(),
                    })
                  }
                  disabled={remove.isPending}
                >
                  {remove.isPending ? (
                    <Loader2 className="size-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="size-4 mr-2" />
                  )}
                  Delete
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => activate.mutate()}
                disabled={
                  !workspaceId ||
                  activate.isPending ||
                  (selectedThemeId === activeThemeId && !dirty)
                }
              >
                {activate.isPending ? (
                  <Loader2 className="size-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="size-4 mr-2" />
                )}
                {selectedThemeId === activeThemeId ? "Re-activate" : "Activate"}
              </Button>
              <Button
                size="sm"
                onClick={() => save.mutate()}
                disabled={!dirty || save.isPending || !workspaceId}
              >
                {save.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
                Save theme
              </Button>
            </div>
            <div className="w-full">
              <Textarea
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="Description (optional)"
                rows={1}
                className="text-xs"
                disabled={!workspaceId}
              />
            </div>
            {activeThemeId && selectedThemeId !== activeThemeId && (
              <p className="w-full text-xs text-muted-foreground">
                Live right now:{" "}
                <span className="font-medium text-foreground">
                  {myThemes.find((t) => t.id === activeThemeId)?.name ?? "—"}
                </span>
                . You're editing a different theme — nothing changes for visitors until you hit
                Activate.
              </p>
            )}
          </CardContent>
        </Card>

        {section === "brand-colors" && <BrandColorsSection form={form} set={set} />}
        {section === "other-colors" && <OtherColorsSection form={form} set={set} />}
        {section === "typography" && <TypographySection form={form} set={set} />}
        {section === "layout" && <LayoutSection form={form} set={set} />}
        {section === "modes" && <ModesSection form={form} set={set} />}
        {section === "identity" && (
          <IdentitySection form={form} set={set} brandScope={brandScope} />
        )}
        {section === "login" && <LoginSection form={form} set={set} />}
        {section === "email" && <EmailSection form={form} set={set} brandScope={brandScope} />}
      </div>

      <Dialog open={marketplaceOpen} onOpenChange={setMarketplaceOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Theme Marketplace</DialogTitle>
            <DialogDescription>
              Shared, ready-made themes anyone can activate. To customize one, create your own theme
              instead — editing here isn't possible since these are shared with every workspace that
              installs them.
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
            {(marketplaceQ.data?.themes ?? []).length === 0 && (
              <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                No themes available yet.
              </p>
            )}
            {(marketplaceQ.data?.themes ?? []).map((t: any) => (
              <Card key={t.id}>
                <CardContent className="space-y-1.5 p-3">
                  <h3 className="text-sm font-semibold">{t.name}</h3>
                  <p className="min-h-[2rem] text-xs text-muted-foreground line-clamp-2">
                    {t.description ?? "—"}
                  </p>
                  <div className="flex gap-1">
                    {(Object.values(t.tokens ?? {}) as string[]).slice(0, 5).map((c, i) => (
                      <span
                        key={i}
                        className="size-4 rounded-control border"
                        style={{ background: String(c) }}
                      />
                    ))}
                  </div>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => activateMarketplace.mutate(t.id)}
                    disabled={activateMarketplace.isPending}
                  >
                    Activate
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPrompt(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmPrompt?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmPrompt?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmPrompt?.onConfirm();
                setConfirmPrompt(null);
              }}
            >
              {confirmPrompt?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type SectionProps = {
  form: ThemeConfig;
  set: (k: keyof ThemeConfig, v: string | number | null) => void;
};

function str(v: string | number | null | undefined): string {
  return v == null ? "" : String(v);
}

function BrandColorsSection({ form, set }: SectionProps) {
  const { accent, setPreviewAccent } = useTenantAccent();
  const draft = str(form.accent_color) || DEFAULT_ACCENT;
  const contrast = useMemo(() => evaluateAccentContrast(draft), [draft]);
  const suggestions = useMemo(
    () =>
      contrast.valid && (!contrast.safe || contrast.issues.length > 0)
        ? suggestAccentPairings(draft)
        : [],
    [draft, contrast],
  );
  const previewFill = useMemo(() => accentStrong(accent), [accent]);

  useEffect(() => () => setPreviewAccent(null), [setPreviewAccent]);

  const pick = (hex: string) => {
    set("accent_color", hex);
    setPreviewAccent(hex);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Brand color</CardTitle>
          <CardDescription>
            The primary color for buttons, navigation, and theme gradients.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ColorField
            label="Primary color"
            value={str(form.primary_color)}
            onChange={(v) => set("primary_color", v)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Brand accent</CardTitle>
          <CardDescription>
            One accent color applied to highlights, commerce, Social Studio, and Digital Cards.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                aria-label={`Accent ${p.label}`}
                onClick={() => pick(p.value)}
                className={`size-8 rounded-full border-2 transition ${draft.toLowerCase() === p.value.toLowerCase() ? "border-foreground" : "border-transparent"}`}
                style={{ background: p.value }}
              />
            ))}
            <div className="ml-1 flex items-center gap-2">
              <Input
                value={str(form.accent_color)}
                onChange={(e) => {
                  set("accent_color", e.target.value);
                  if (isValidAccent(e.target.value)) setPreviewAccent(e.target.value);
                }}
                className="w-32 font-mono"
                placeholder={DEFAULT_ACCENT}
              />
              <input
                type="color"
                value={isValidAccent(draft) ? draft : accent}
                onChange={(e) => pick(e.target.value)}
                className="size-9 rounded border bg-transparent p-0.5"
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium text-muted-foreground">Accessible presets</p>
              <Badge variant="outline" className="text-[11px]">
                WCAG AA verified
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {ACCESSIBLE_ACCENT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  title={`${p.label} · ${p.value}`}
                  onClick={() => pick(p.value)}
                  className={`size-8 rounded-full border-2 transition ${draft.toLowerCase() === p.value.toLowerCase() ? "border-foreground" : "border-transparent"}`}
                  style={{ background: p.value }}
                />
              ))}
            </div>
          </div>
          {contrast.valid && (
            <div
              className={`rounded-control border p-3 space-y-2 ${
                !contrast.safe
                  ? "border-destructive/50 bg-destructive/5"
                  : contrast.issues.length > 0
                    ? "border-amber-500/50 bg-amber-500/5"
                    : "border-emerald-500/40 bg-emerald-500/5"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                {!contrast.safe ? (
                  <>
                    <ShieldAlert className="size-4 text-destructive" aria-hidden />
                    Accessible variants will be applied
                  </>
                ) : contrast.issues.length > 0 ? (
                  <>
                    <AlertTriangle className="size-4 text-amber-600" aria-hidden />
                    Usable, but contrast is tight
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
                    Contrast passes WCAG AA
                  </>
                )}
              </div>
              {suggestions.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <p className="text-xs font-medium">Accessible alternatives in your hue</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {suggestions.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => pick(s.value)}
                        className="flex items-center gap-3 rounded-control border p-2 text-left transition hover:bg-muted/60"
                      >
                        <span
                          className="flex size-9 shrink-0 items-center justify-center rounded text-[11px] font-semibold"
                          style={{ background: s.value, color: s.foreground }}
                        >
                          Aa
                        </span>
                        <span className="min-w-0">
                          <span className="block font-mono text-xs">{s.value}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {s.label}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <span
            className="inline-block rounded-control px-3 py-2 text-sm font-medium text-white"
            style={{ background: previewFill }}
          >
            Preview
          </span>
        </CardContent>
      </Card>
    </>
  );
}

function OtherColorsSection({ form, set }: SectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Other colors</CardTitle>
        <CardDescription>Optional overrides. Leave blank to use the default look.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ColorField
          label="Secondary"
          value={str(form.secondary_color)}
          onChange={(v) => set("secondary_color", v)}
        />
        <ColorField
          label="Background"
          value={str(form.background_color)}
          onChange={(v) => set("background_color", v)}
        />
        <ColorField
          label="Text"
          value={str(form.foreground_color)}
          onChange={(v) => set("foreground_color", v)}
        />
        <ColorField
          label="App border"
          value={str(form.border_color)}
          onChange={(v) => set("border_color", v)}
        />
      </CardContent>
    </Card>
  );
}

function TypographySection({ form, set }: SectionProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Fonts</CardTitle>
          <CardDescription>Pick from the Google Fonts library for each role.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <GoogleFontField
            label="Sans font"
            hint="Body text across the app."
            family={str(form.font_family_sans)}
            weight={str(form.font_weight_sans)}
            onFamilyChange={(v) => set("font_family_sans", v)}
            onWeightChange={(v) => set("font_weight_sans", v)}
          />
          <GoogleFontField
            label="Heading font"
            hint="Page titles and section headings."
            family={str(form.font_family_heading)}
            weight={str(form.font_weight_heading)}
            onFamilyChange={(v) => set("font_family_heading", v)}
            onWeightChange={(v) => set("font_weight_heading", v)}
          />
          <GoogleFontField
            label="Mono font"
            hint="Code blocks and technical fields."
            family={str(form.font_family_mono)}
            weight={str(form.font_weight_mono)}
            onFamilyChange={(v) => set("font_family_mono", v)}
            onWeightChange={(v) => set("font_weight_mono", v)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Base font size</CardTitle>
        </CardHeader>
        <CardContent>
          <FontSizeField
            value={str(form.font_size_base) || "16px"}
            onChange={(v) => set("font_size_base", v)}
          />
        </CardContent>
      </Card>
    </>
  );
}

function LayoutSection({ form, set }: SectionProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Sidebar theme</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <ColorField
            label="Sidebar background"
            value={str(form.sidebar_background)}
            onChange={(v) => set("sidebar_background", v)}
          />
          <ColorField
            label="Sidebar foreground"
            value={str(form.sidebar_foreground)}
            onChange={(v) => set("sidebar_foreground", v)}
          />
          <ColorField
            label="Sidebar accent"
            value={str(form.sidebar_accent)}
            onChange={(v) => set("sidebar_accent", v)}
          />
          <ColorField
            label="Sidebar border"
            value={str(form.sidebar_border)}
            onChange={(v) => set("sidebar_border", v)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Dashboard theme</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ColorField
            label="Dashboard background"
            value={str(form.dashboard_background)}
            onChange={(v) => set("dashboard_background", v)}
          />
          <ColorField
            label="Dashboard accent"
            value={str(form.dashboard_accent)}
            onChange={(v) => set("dashboard_accent", v)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Icons & radius</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Icon style">
            <Select
              value={str(form.icon_style) || "outline"}
              onValueChange={(v) => set("icon_style", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outline">Outline</SelectItem>
                <SelectItem value="solid">Solid</SelectItem>
                <SelectItem value="duotone">Duotone</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Icon stroke width">
            <Input
              type="number"
              step="0.25"
              min="0.5"
              max="4"
              value={form.icon_stroke_width ?? 2}
              onChange={(e) => set("icon_stroke_width", Number(e.target.value))}
            />
          </Field>
          <Field label="Border radius">
            <Input
              value={str(form.border_radius)}
              onChange={(e) => set("border_radius", e.target.value)}
              placeholder="0.75rem"
            />
          </Field>
        </CardContent>
      </Card>
    </>
  );
}

function ModesSection({ form, set }: SectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sun className="size-4" />/<Moon className="size-4" />
          Dark & light
        </CardTitle>
        <CardDescription>
          Default mode and dark-mode color overrides for this theme.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Default color mode">
          <Select
            value={str(form.default_color_mode) || "system"}
            onValueChange={(v) => set("default_color_mode", v)}
          >
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">Follow system</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <ColorField
            label="Dark primary"
            value={str(form.dark_primary_color)}
            onChange={(v) => set("dark_primary_color", v)}
          />
          <ColorField
            label="Dark background"
            value={str(form.dark_background_color)}
            onChange={(v) => set("dark_background_color", v)}
          />
          <ColorField
            label="Dark accent"
            value={str(form.dark_accent_color)}
            onChange={(v) => set("dark_accent_color", v)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function IdentitySection({ form, set, brandScope }: SectionProps & { brandScope: BrandingScope }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Brand identity</CardTitle>
          <CardDescription>Logo, favicon, and brand name for this theme.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Brand name">
            <Input
              value={str(form.brand_name)}
              onChange={(e) => set("brand_name", e.target.value)}
              placeholder="Acme Inc"
            />
          </Field>
          <Field label="Support email">
            <Input
              value={str(form.support_email)}
              onChange={(e) => set("support_email", e.target.value)}
              placeholder="help@acme.com"
            />
          </Field>
          <ImageDropUpload
            label="Logo (light)"
            value={str(form.logo_url)}
            onChange={(v) => set("logo_url", v)}
            scope={brandScope}
            slot="logo-light"
          />
          <ImageDropUpload
            label="Logo (dark)"
            value={str(form.logo_dark_url)}
            onChange={(v) => set("logo_dark_url", v)}
            scope={brandScope}
            slot="logo-dark"
            dark
          />
          <ImageDropUpload
            label="Favicon"
            value={str(form.favicon_url)}
            onChange={(v) => set("favicon_url", v)}
            scope={brandScope}
            slot="favicon"
            hint="Square PNG, SVG or ICO"
          />
          <Field label="Support URL">
            <Input
              value={str(form.support_url)}
              onChange={(e) => set("support_url", e.target.value)}
              placeholder="https://acme.com/help"
            />
          </Field>
          <Field label="Meta title" className="md:col-span-2">
            <Input
              value={str(form.meta_title)}
              onChange={(e) => set("meta_title", e.target.value)}
              placeholder="Acme — Customer Platform"
            />
          </Field>
          <Field label="Meta description" className="md:col-span-2">
            <Textarea
              rows={2}
              value={str(form.meta_description)}
              onChange={(e) => set("meta_description", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Social handles</CardTitle>
          <CardDescription>Public footer links and default Social Studio accounts.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="X (Twitter)">
            <Input value={str(form.social_x)} onChange={(e) => set("social_x", e.target.value)} />
          </Field>
          <Field label="Instagram">
            <Input
              value={str(form.social_instagram)}
              onChange={(e) => set("social_instagram", e.target.value)}
            />
          </Field>
          <Field label="Facebook Page">
            <Input
              value={str(form.social_facebook)}
              onChange={(e) => set("social_facebook", e.target.value)}
            />
          </Field>
          <Field label="TikTok">
            <Input
              value={str(form.social_tiktok)}
              onChange={(e) => set("social_tiktok", e.target.value)}
            />
          </Field>
          <Field label="Threads">
            <Input
              value={str(form.social_threads)}
              onChange={(e) => set("social_threads", e.target.value)}
            />
          </Field>
          <Field label="YouTube">
            <Input
              value={str(form.social_youtube)}
              onChange={(e) => set("social_youtube", e.target.value)}
            />
          </Field>
          <Field label="LinkedIn">
            <Input
              value={str(form.social_linkedin)}
              onChange={(e) => set("social_linkedin", e.target.value)}
            />
          </Field>
          <Field label="Website">
            <Input
              value={str(form.social_website)}
              onChange={(e) => set("social_website", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>
    </>
  );
}

function LoginSection({ form, set }: SectionProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogIn className="size-4" />
            Login page
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Layout">
            <Select
              value={str(form.login_layout) || "centered"}
              onValueChange={(v) => set("login_layout", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="centered">Centered card</SelectItem>
                <SelectItem value="split">Split screen</SelectItem>
                <SelectItem value="minimal">Minimal</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Background image URL">
            <Input
              value={str(form.login_background_url)}
              onChange={(e) => set("login_background_url", e.target.value)}
            />
          </Field>
          <Field label="Headline" className="md:col-span-2">
            <Input
              value={str(form.login_headline)}
              onChange={(e) => set("login_headline", e.target.value)}
              placeholder="Welcome back to Acme"
            />
          </Field>
          <Field label="Subheadline" className="md:col-span-2">
            <Textarea
              rows={2}
              value={str(form.login_subheadline)}
              onChange={(e) => set("login_subheadline", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Loader</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Loader style">
            <Select
              value={str(form.loader_style) || "spinner"}
              onValueChange={(v) => set("loader_style", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="spinner">Spinner</SelectItem>
                <SelectItem value="dots">Dots</SelectItem>
                <SelectItem value="bar">Progress bar</SelectItem>
                <SelectItem value="logo">Animated logo</SelectItem>
                <SelectItem value="custom">Custom image</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Loader image URL (for custom / logo)">
            <Input
              value={str(form.loader_url)}
              onChange={(e) => set("loader_url", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>
    </>
  );
}

function EmailSection({ form, set, brandScope }: SectionProps & { brandScope: BrandingScope }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" />
          Email branding
        </CardTitle>
        <CardDescription>Applied to every transactional and marketing email.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="From name">
          <Input
            value={str(form.email_from_name)}
            onChange={(e) => set("email_from_name", e.target.value)}
            placeholder="Acme Team"
          />
        </Field>
        <ImageDropUpload
          label="Email logo"
          value={str(form.email_logo_url)}
          onChange={(v) => set("email_logo_url", v)}
          scope={brandScope}
          slot="email-logo"
        />
        <ColorField
          label="Email primary color"
          value={str(form.email_primary_color)}
          onChange={(v) => set("email_primary_color", v)}
        />
        <ColorField
          label="Email header color"
          value={str(form.email_header_color)}
          onChange={(v) => set("email_header_color", v)}
        />
        <Field label="Email footer (HTML allowed)" className="md:col-span-2">
          <Textarea
            rows={4}
            value={str(form.custom_email_footer)}
            onChange={(e) => set("custom_email_footer", e.target.value)}
          />
        </Field>
      </CardContent>
    </Card>
  );
}
