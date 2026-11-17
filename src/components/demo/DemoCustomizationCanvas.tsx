import React, { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sparkles,
  Palette,
  Type,
  LayoutDashboard,
  RotateCcw,
  Check,
  Sun,
  Moon,
  Laptop,
  CheckCircle2,
  Sliders,
} from "lucide-react";
import {
  useDemoCustomizationStore,
  type DemoCustomizationConfig,
} from "@/lib/demo/demo-customization";
import { GOOGLE_FONTS, fontFamilyValue } from "@/lib/fonts/google-fonts";
import { ACCENT_PRESETS, ACCESSIBLE_ACCENT_PRESETS } from "@/lib/themes/accent-color";
import { useTheme } from "@/shared/providers/theme-provider";
import { toast } from "sonner";

type ThemePreset = {
  name: string;
  primary: string;
  accent: string;
  sidebarBg: string;
  sidebarFg: string;
  sansFont?: string;
  headingFont?: string;
  radius?: string;
};

const THEME_PRESETS: ThemePreset[] = [
  {
    name: "WhatsApp Classic",
    primary: "#075e54",
    accent: "#25d366",
    sidebarBg: "#f0f2f5",
    sidebarFg: "#111827",
    sansFont: "Inter",
    headingFont: "Inter",
    radius: "0.5rem",
  },
  {
    name: "Emerald Pro",
    primary: "#059669",
    accent: "#10b981",
    sidebarBg: "#f0fdf4",
    sidebarFg: "#064e3b",
    sansFont: "Plus Jakarta Sans",
    headingFont: "Plus Jakarta Sans",
    radius: "0.75rem",
  },
  {
    name: "Royal Blue",
    primary: "#1d4ed8",
    accent: "#3b82f6",
    sidebarBg: "#eff6ff",
    sidebarFg: "#1e3a8a",
    sansFont: "Rubik",
    headingFont: "Rubik",
    radius: "0.5rem",
  },
  {
    name: "Violet Tech",
    primary: "#6d28d9",
    accent: "#8b5cf6",
    sidebarBg: "#f5f3ff",
    sidebarFg: "#4c1d95",
    sansFont: "Space Grotesk",
    headingFont: "Space Grotesk",
    radius: "0.75rem",
  },
  {
    name: "Sunset Rose",
    primary: "#be123c",
    accent: "#f43f5e",
    sidebarBg: "#fff1f2",
    sidebarFg: "#881337",
    sansFont: "Montserrat",
    headingFont: "Montserrat",
    radius: "0.5rem",
  },
  {
    name: "Dark Slate",
    primary: "#0f172a",
    accent: "#38bdf8",
    sidebarBg: "#1e293b",
    sidebarFg: "#f8fafc",
    sansFont: "JetBrains Mono",
    headingFont: "Inter",
    radius: "0.375rem",
  },
];

const POPULAR_FONTS = [
  "Inter",
  "Rubik",
  "Plus Jakarta Sans",
  "IBM Plex Sans",
  "Space Grotesk",
  "Montserrat",
  "Poppins",
  "Outfit",
  "Manrope",
  "Open Sans",
  "Roboto",
];

const RADIUS_OPTIONS = [
  { label: "Sharp · 0", value: "0rem" },
  { label: "Subtle · 6px", value: "0.375rem" },
  { label: "Medium · 8px", value: "0.5rem" },
  { label: "Soft · 12px", value: "0.75rem" },
  { label: "Round · 16px", value: "1rem" },
];

export function DemoCustomizationCanvas() {
  const { isDemo, config, hasCustomizations, update, reset } = useDemoCustomizationStore();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("presets");
  const { setTheme, theme: colorMode } = useTheme();

  // In production mode, do not render this canvas or trigger at all
  if (!isDemo) return null;

  const currentPrimary = config?.primary_color ?? "";
  const currentAccent = config?.accent_color ?? "";
  const currentSans = config?.font_family_sans ?? "Inter";
  const currentHeading = config?.font_family_heading ?? currentSans;
  const currentHeadingWeight = config?.font_weight_heading ?? "600";
  const currentBaseSize = config?.font_size_base ?? "16px";
  const currentRadius = config?.border_radius ?? "0.5rem";

  const applyPreset = (p: ThemePreset) => {
    update({
      primary_color: p.primary,
      accent_color: p.accent,
      sidebar_background: p.sidebarBg,
      sidebar_foreground: p.sidebarFg,
      font_family_sans: p.sansFont ?? currentSans,
      font_family_heading: p.headingFont ?? currentHeading,
      border_radius: p.radius ?? currentRadius,
    });
    toast.success(`Applied ${p.name} theme preview`);
  };

  const handleReset = () => {
    reset();
    toast.info("Customization reset to default workspace settings");
  };

  const pxSize = parseInt(currentBaseSize, 10) || 16;

  return (
    <>
      {/* Floating Canvas Trigger Button — edge positioned, non-intrusive */}
      <div className="fixed bottom-5 right-5 z-40">
        <button
          onClick={() => setOpen(true)}
          className="demo-canvas-trigger group flex items-center gap-2 rounded-full border border-border bg-card pl-2 pr-3 py-2 text-xs font-semibold text-foreground transition-all hover:bg-surface focus:outline-none focus:ring-2 focus:ring-primary cursor-pointer"
          title="Explore White-Labeling (Demo Mode)"
          aria-label="Open White-Label Customization Canvas"
        >
          <div className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:rotate-12">
            <Sparkles className="size-3.5" />
          </div>
          <span className="font-semibold text-muted-foreground">White-Label Studio</span>
          {hasCustomizations ? (
            <Badge variant="default" className="h-5 px-1.5 text-[10px] font-bold">
              Active
            </Badge>
          ) : (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal opacity-80">
              Demo
            </Badge>
          )}
        </button>
      </div>

      {/* Off-Canvas Sheet / Drawer */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-md md:max-w-lg">
          {/* Header */}
          <div className="border-b border-border p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-control bg-primary/10 text-primary">
                  <Palette className="size-4" />
                </div>
                <div>
                  <SheetTitle className="text-base font-semibold">White-Label Studio</SheetTitle>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[11px] text-muted-foreground">
                      Demo Live Preview · LocalStorage Only
                    </span>
                  </div>
                </div>
              </div>

              {hasCustomizations && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleReset}
                  className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-destructive"
                  title="Reset all demo customizations to defaults"
                >
                  <RotateCcw className="size-3.5" />
                  <span>Reset</span>
                </Button>
              )}
            </div>

            <SheetDescription className="mt-2 text-xs text-muted-foreground">
              Customize colors, fonts, layout, and mode in real time. Changes are reflected live
              across the entire CRM without saving to the database.
            </SheetDescription>

            {/* Navigation Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
              <TabsList className="grid w-full grid-cols-4 h-9">
                <TabsTrigger value="presets" className="text-xs gap-1">
                  <Sparkles className="size-3" />
                  Themes
                </TabsTrigger>
                <TabsTrigger value="colors" className="text-xs gap-1">
                  <Palette className="size-3" />
                  Colors
                </TabsTrigger>
                <TabsTrigger value="typography" className="text-xs gap-1">
                  <Type className="size-3" />
                  Typography
                </TabsTrigger>
                <TabsTrigger value="layout" className="text-xs gap-1">
                  <Sliders className="size-3" />
                  Layout
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* Scrollable Canvas Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {/* TAB: PRESETS */}
            {activeTab === "presets" && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    One-Click Theme Presets
                  </h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try curated design systems built for modern SaaS brands.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {THEME_PRESETS.map((preset) => {
                    const isSelected =
                      currentPrimary.toLowerCase() === preset.primary.toLowerCase() &&
                      currentAccent.toLowerCase() === preset.accent.toLowerCase();

                    return (
                      <button
                        key={preset.name}
                        onClick={() => applyPreset(preset)}
                        className={`group flex flex-col items-start rounded-control border p-3 text-left transition-all ${
                          isSelected
                            ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                            : "border-border bg-card hover:border-primary/40 hover:bg-muted/30"
                        }`}
                      >
                        <div className="flex w-full items-center justify-between">
                          <span className="font-heading text-xs font-semibold">{preset.name}</span>
                          {isSelected && <Check className="size-3.5 text-primary" />}
                        </div>

                        <div className="mt-2.5 flex items-center gap-1.5">
                          <span
                            className="size-4 rounded-full border border-black/10 shadow-sm"
                            style={{ backgroundColor: preset.primary }}
                            title={`Primary: ${preset.primary}`}
                          />
                          <span
                            className="size-4 rounded-full border border-black/10 shadow-sm"
                            style={{ backgroundColor: preset.accent }}
                            title={`Accent: ${preset.accent}`}
                          />
                          <span
                            className="size-4 rounded-full border border-black/10 shadow-sm"
                            style={{ backgroundColor: preset.sidebarBg }}
                            title={`Sidebar: ${preset.sidebarBg}`}
                          />
                          <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                            {preset.sansFont}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TAB: COLORS */}
            {activeTab === "colors" && (
              <div className="space-y-5">
                {/* Brand Primary */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground">
                    Brand Color (Primary)
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Main button color, active indicators, and key touchpoints.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={currentPrimary || "#25D366"}
                      onChange={(e) => update({ primary_color: e.target.value })}
                      className="size-9 cursor-pointer rounded-control border border-input bg-background p-0.5"
                    />
                    <input
                      type="text"
                      value={currentPrimary}
                      placeholder="#059669"
                      onChange={(e) => update({ primary_color: e.target.value })}
                      className="flex-1 rounded-control border border-input bg-background px-3 py-1.5 font-mono text-xs"
                    />
                    {currentPrimary && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => update({ primary_color: null })}
                        className="h-8 text-xs text-muted-foreground"
                      >
                        Default
                      </Button>
                    )}
                  </div>
                </div>

                {/* Accent Swatches */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground">Accent Color</label>
                  <p className="text-[11px] text-muted-foreground">
                    Badges, links, highlights, and secondary actions.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {[...ACCENT_PRESETS, ...ACCESSIBLE_ACCENT_PRESETS.slice(0, 8)].map((acc) => (
                      <button
                        key={acc.value}
                        type="button"
                        onClick={() => update({ accent_color: acc.value })}
                        className={`size-6 rounded-full border transition-transform hover:scale-110 ${
                          currentAccent.toLowerCase() === acc.value.toLowerCase()
                            ? "ring-2 ring-primary ring-offset-2"
                            : "border-black/10"
                        }`}
                        style={{ backgroundColor: acc.value }}
                        title={`${acc.label} (${acc.value})`}
                      />
                    ))}
                  </div>
                </div>

                {/* Sidebar Theme */}
                <div className="rounded-control border border-border bg-muted/20 p-3.5 space-y-3">
                  <span className="text-xs font-semibold text-foreground">Sidebar Palette</span>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <span className="text-[11px] text-muted-foreground block mb-1">
                        Background
                      </span>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={config?.sidebar_background || "#ffffff"}
                          onChange={(e) => update({ sidebar_background: e.target.value })}
                          className="size-7 cursor-pointer rounded-control border border-input p-0"
                        />
                        <span className="font-mono text-[11px] text-muted-foreground truncate">
                          {config?.sidebar_background || "Default"}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block mb-1">
                        Text Color
                      </span>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={config?.sidebar_foreground || "#111827"}
                          onChange={(e) => update({ sidebar_foreground: e.target.value })}
                          className="size-7 cursor-pointer rounded-control border border-input p-0"
                        />
                        <span className="font-mono text-[11px] text-muted-foreground truncate">
                          {config?.sidebar_foreground || "Default"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: TYPOGRAPHY */}
            {activeTab === "typography" && (
              <div className="space-y-5">
                {/* Sans Font */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Body Font (Sans)</label>
                  <p className="text-[11px] text-muted-foreground">
                    Used for all paragraphs, inputs, and tables.
                  </p>
                  <select
                    value={currentSans}
                    onChange={(e) => update({ font_family_sans: e.target.value })}
                    className="w-full rounded-control border border-input bg-background px-3 py-2 text-xs"
                  >
                    {POPULAR_FONTS.map((font) => (
                      <option key={font} value={font}>
                        {font}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Heading Font */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Heading Font</label>
                  <p className="text-[11px] text-muted-foreground">
                    Used for page headers, cards, and titles.
                  </p>
                  <select
                    value={currentHeading}
                    onChange={(e) => update({ font_family_heading: e.target.value })}
                    className="w-full rounded-control border border-input bg-background px-3 py-2 text-xs"
                  >
                    {POPULAR_FONTS.map((font) => (
                      <option key={font} value={font}>
                        {font}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Heading Weight */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Heading Weight</label>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: "400 Regular", val: "400" },
                      { label: "500 Medium", val: "500" },
                      { label: "600 Semibold", val: "600" },
                      { label: "700 Bold", val: "700" },
                    ].map((w) => (
                      <Button
                        key={w.val}
                        type="button"
                        size="sm"
                        variant={currentHeadingWeight === w.val ? "default" : "outline"}
                        onClick={() => update({ font_weight_heading: w.val })}
                        className="h-7 text-xs px-2.5"
                      >
                        {w.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Base Font Size */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-foreground">Base Font Size</label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {currentBaseSize}
                    </span>
                  </div>
                  <Slider
                    min={13}
                    max={20}
                    step={1}
                    value={[pxSize]}
                    onValueChange={([v]) => update({ font_size_base: `${v}px` })}
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>Compact (14px)</span>
                    <span>Default (16px)</span>
                    <span>Large (18px)</span>
                  </div>
                </div>

                {/* Live Font Preview Box */}
                <div className="rounded-control border border-border bg-muted/30 p-3.5 space-y-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Live Preview
                  </span>
                  <p
                    className="text-base font-semibold"
                    style={{
                      fontFamily: fontFamilyValue(currentHeading),
                      fontWeight: Number(currentHeadingWeight),
                    }}
                  >
                    {currentHeading} · Page Title Preview
                  </p>
                  <p
                    className="text-xs text-muted-foreground"
                    style={{ fontFamily: fontFamilyValue(currentSans) }}
                  >
                    This is sample body text rendered in {currentSans} ({currentBaseSize}). The
                    quick brown fox jumps over the lazy dog.
                  </p>
                </div>
              </div>
            )}

            {/* TAB: LAYOUT */}
            {activeTab === "layout" && (
              <div className="space-y-5">
                {/* Color Mode */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Color Mode</label>
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      type="button"
                      variant={colorMode === "light" ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        setTheme("light");
                        update({ default_color_mode: "light" });
                      }}
                      className="gap-1.5 text-xs h-8"
                    >
                      <Sun className="size-3.5" /> Light
                    </Button>
                    <Button
                      type="button"
                      variant={colorMode === "dark" ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        setTheme("dark");
                        update({ default_color_mode: "dark" });
                      }}
                      className="gap-1.5 text-xs h-8"
                    >
                      <Moon className="size-3.5" /> Dark
                    </Button>
                    <Button
                      type="button"
                      variant={colorMode === "system" ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        setTheme("system");
                        update({ default_color_mode: "system" });
                      }}
                      className="gap-1.5 text-xs h-8"
                    >
                      <Laptop className="size-3.5" /> System
                    </Button>
                  </div>
                </div>

                {/* Border Radius */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Border Radius</label>
                  <div className="grid grid-cols-2 gap-2">
                    {RADIUS_OPTIONS.map((r) => (
                      <Button
                        key={r.value}
                        type="button"
                        size="sm"
                        variant={currentRadius === r.value ? "default" : "outline"}
                        onClick={() => update({ border_radius: r.value })}
                        className="text-xs h-8 justify-start"
                      >
                        {r.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Workspace Name */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">Brand Name</label>
                  <input
                    type="text"
                    value={config?.brand_name ?? ""}
                    placeholder="e.g. Acme CRM"
                    onChange={(e) => update({ brand_name: e.target.value })}
                    className="w-full rounded-control border border-input bg-background px-3 py-2 text-xs font-medium"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Replaces brand wordmarks in topbar and navigation.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Footer note & Reset action */}
          <div className="border-t border-border bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
                <span className="text-[11px]">Previewing in browser memory</span>
              </div>

              <div className="flex items-center gap-2">
                {hasCustomizations && (
                  <Button variant="outline" size="sm" onClick={handleReset} className="h-8 text-xs">
                    Reset defaults
                  </Button>
                )}
                <Button size="sm" onClick={() => setOpen(false)} className="h-8 text-xs">
                  Done exploring
                </Button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
