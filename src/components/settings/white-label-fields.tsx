/** Small presentational field controls shared by the Theme Manager (per-theme
 * editor) and the Domain section of Customization settings. */
import { useEffect } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
  GOOGLE_FONTS,
  FONT_WEIGHT_LABELS,
  FONT_SIZE_PRESETS,
  findGoogleFont,
  fontFamilyValue,
  loadGoogleFontLink,
  removeGoogleFontLink,
} from "@/lib/fonts/google-fonts";

export function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`space-y-1.5 block ${className}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const isHex = /^#[0-9a-f]{3,8}$/i.test(value);
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={isHex ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-14 rounded-control border border-input bg-background cursor-pointer"
          aria-label={`${label} color picker`}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#111827 or 220 90% 56%"
          className="flex-1 font-mono text-sm"
        />
      </div>
    </Field>
  );
}

const GOOGLE_FONT_OPTIONS = GOOGLE_FONTS.map((f) => ({
  value: f.family,
  label: f.family,
  keywords: f.category,
}));

export function GoogleFontField({
  label,
  hint,
  family,
  weight,
  onFamilyChange,
  onWeightChange,
}: {
  label: string;
  hint?: string;
  family: string;
  weight: string;
  onFamilyChange: (v: string) => void;
  onWeightChange: (v: string) => void;
}) {
  const font = findGoogleFont(family);
  const weights = font?.weights ?? [];
  const activeWeight =
    weight && weights.includes(Number(weight)) ? weight : String(weights[0] ?? "400");

  useEffect(() => {
    const id = `wacrm-font-preview-${label.replace(/\s+/g, "-").toLowerCase()}`;
    if (font) loadGoogleFontLink(id, [{ family: font.family }]);
    else removeGoogleFontLink(id);
    return () => removeGoogleFontLink(id);
  }, [font, activeWeight, label]);

  return (
    <div className="space-y-3">
      <Field label={label}>
        <Combobox
          options={GOOGLE_FONT_OPTIONS}
          value={family}
          onChange={(v) => {
            onFamilyChange(v);
            const next = findGoogleFont(v);
            if (next && !next.weights.includes(Number(weight))) {
              onWeightChange(String(next.weights.includes(400) ? 400 : next.weights[0]));
            }
          }}
          placeholder="Search Google Fonts…"
          searchPlaceholder="Search 50+ fonts…"
        />
      </Field>
      {hint && <p className="-mt-2 text-xs text-muted-foreground">{hint}</p>}
      <Field label="Weight">
        <Select value={activeWeight} onValueChange={onWeightChange} disabled={!font}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {weights.map((w) => (
              <SelectItem key={w} value={String(w)}>
                {w} · {FONT_WEIGHT_LABELS[w] ?? "Custom"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {font && (
        <p
          className="truncate rounded-control border border-border bg-muted/30 px-3 py-2 text-base"
          style={{ fontFamily: fontFamilyValue(family), fontWeight: Number(activeWeight) }}
        >
          The quick brown fox jumps over the lazy dog
        </p>
      )}
    </div>
  );
}

export function FontSizeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const px = Math.min(24, Math.max(12, parseInt(value, 10) || 16));
  return (
    <div className="max-w-md space-y-3">
      <div className="flex flex-wrap gap-2">
        {FONT_SIZE_PRESETS.map((preset) => (
          <Button
            key={preset.value}
            type="button"
            size="sm"
            variant={value === preset.value ? "default" : "outline"}
            onClick={() => onChange(preset.value)}
          >
            {preset.label} · {preset.value}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Slider
          min={12}
          max={24}
          step={1}
          value={[px]}
          onValueChange={([v]) => onChange(`${v}px`)}
          className="flex-1"
        />
        <span className="w-12 shrink-0 text-right font-mono text-sm text-muted-foreground">
          {px}px
        </span>
      </div>
    </div>
  );
}
