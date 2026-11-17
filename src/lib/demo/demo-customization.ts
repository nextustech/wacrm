/**
 * Demo Mode Customization Store.
 *
 * Allows visitors in Demo Mode to explore and customize white-labeling
 * (colors, fonts, theme, radius, branding) in real time without persisting
 * any changes to the Supabase database.
 *
 * State is stored strictly in `localStorage` under `wacrm.demo-customization.v1`.
 * In Production Mode, this store is completely inert and does not mount.
 */

import { useSyncExternalStore } from 'react';
import { isDemoMode } from './mode';

export const DEMO_CUSTOMIZATION_STORAGE_KEY = 'wacrm.demo-customization.v1';

export type DemoCustomizationConfig = {
  primary_color?: string | null;
  accent_color?: string | null;
  secondary_color?: string | null;
  background_color?: string | null;
  foreground_color?: string | null;
  border_color?: string | null;
  sidebar_background?: string | null;
  sidebar_foreground?: string | null;
  sidebar_accent?: string | null;
  sidebar_border?: string | null;
  dashboard_background?: string | null;
  dashboard_accent?: string | null;
  font_family_sans?: string | null;
  font_family_heading?: string | null;
  font_family_mono?: string | null;
  font_weight_sans?: string | null;
  font_weight_heading?: string | null;
  font_weight_mono?: string | null;
  font_size_base?: string | null;
  border_radius?: string | null;
  icon_style?: 'outline' | 'solid' | 'duotone' | null;
  icon_stroke_width?: number | null;
  default_color_mode?: 'light' | 'dark' | 'system' | null;
  brand_name?: string | null;
  logo_url?: string | null;
  logo_dark_url?: string | null;
  favicon_url?: string | null;
  is_active?: boolean;
};

/**
 * Returns true if Demo Mode is currently active in the application.
 * Strictly checks the canonical environment mode (`APP_MODE === 'demo'`).
 * In Live / Production mode, this always returns false.
 */
export function isDemoActive(): boolean {
  return isDemoMode();
}

/** In-memory cache to maintain reference identity for useSyncExternalStore */
let cachedRaw: string | null = null;
let cachedConfig: DemoCustomizationConfig | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (e) {
      console.error('[demo-customization] listener error:', e);
    }
  });
}

export function subscribeDemoCustomization(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDemoCustomization(): DemoCustomizationConfig | null {
  if (typeof window === 'undefined') return null;
  if (!isDemoActive()) return null;

  try {
    const raw = window.localStorage.getItem(DEMO_CUSTOMIZATION_STORAGE_KEY);
    if (raw === cachedRaw) return cachedConfig;

    cachedRaw = raw;
    if (!raw) {
      cachedConfig = null;
      return null;
    }

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cachedConfig = parsed as DemoCustomizationConfig;
      return cachedConfig;
    }
    cachedConfig = null;
    return null;
  } catch {
    cachedRaw = null;
    cachedConfig = null;
    return null;
  }
}

export function setDemoCustomization(patch: Partial<DemoCustomizationConfig>) {
  if (typeof window === 'undefined') return;
  try {
    const current = getDemoCustomization() ?? {};
    const next: DemoCustomizationConfig = {
      ...current,
      ...patch,
      is_active: true,
    };
    const serialized = JSON.stringify(next);
    window.localStorage.setItem(DEMO_CUSTOMIZATION_STORAGE_KEY, serialized);
    cachedRaw = serialized;
    cachedConfig = next;
    notify();
  } catch (e) {
    console.error('[demo-customization] failed to save to localStorage:', e);
  }
}

export function resetDemoCustomization() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DEMO_CUSTOMIZATION_STORAGE_KEY);
    cachedRaw = null;
    cachedConfig = null;
    notify();
  } catch (e) {
    console.error('[demo-customization] failed to reset localStorage:', e);
  }
}

/** Hook for subscribing to demo customization in React components */
export function useDemoCustomizationStore() {
  const config = useSyncExternalStore(
    subscribeDemoCustomization,
    getDemoCustomization,
    () => null,
  );

  return {
    isDemo: isDemoActive(),
    config,
    hasCustomizations: Boolean(config && Object.keys(config).length > 0),
    update: setDemoCustomization,
    reset: resetDemoCustomization,
  };
}
