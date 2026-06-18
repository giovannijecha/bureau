"use client";

// Single source of truth for the panel's APPEARANCE: theme mode (light/dark/system),
// accent color, UI scale, and reduced motion. State lives on <html> (a class for dark +
// reduce-motion, CSS custom properties for the accent, font-size for the scale) and in
// localStorage; every useAppearance() instance stays in sync via a custom window event.
// The no-flash inline script in layout.tsx mirrors applyAppearance() so there's no FOUC.

import { useEffect, useState } from "react";

const KEYS = { mode: "bureau.theme", accent: "bureau.accent", scale: "bureau.scale", motion: "bureau.motion" };
const EVENT = "bureau-appearance-change";

export type ThemeMode = "light" | "dark" | "system";
export type ScaleKey = "compact" | "default" | "large";

export interface AccentDef {
  key: string;
  label: string;
  /** A representative color for the picker swatch; "" = the default monochrome accent.
   *  The actual per-theme --primary values live in globals.css keyed by [data-accent]. */
  swatch: string;
}

// The accent KEY is set as `data-accent` on <html>; globals.css defines the real
// (theme-aware) --primary/--primary-foreground/--ring for each — darker on light, lighter
// on dark — so the accent stays AA-legible as both a fill and as text in either theme.
export const ACCENTS: AccentDef[] = [
  { key: "default", label: "Mono", swatch: "" },
  { key: "blue", label: "Blue", swatch: "oklch(0.72 0.15 250)" },
  { key: "violet", label: "Violet", swatch: "oklch(0.71 0.17 290)" },
  { key: "green", label: "Green", swatch: "oklch(0.74 0.16 150)" },
  { key: "teal", label: "Teal", swatch: "oklch(0.77 0.12 200)" },
  { key: "rose", label: "Rose", swatch: "oklch(0.7 0.18 15)" },
  { key: "amber", label: "Amber", swatch: "oklch(0.8 0.14 75)" },
];

export const SCALES: { key: ScaleKey; label: string; px: number }[] = [
  { key: "compact", label: "Compact", px: 14 },
  { key: "default", label: "Default", px: 16 },
  { key: "large", label: "Large", px: 18 },
];

export interface Appearance {
  mode: ThemeMode;
  accent: string;
  scale: ScaleKey;
  reduceMotion: boolean;
}

const DEFAULTS: Appearance = { mode: "dark", accent: "default", scale: "default", reduceMotion: false };

function read(): Appearance {
  try {
    const m = localStorage.getItem(KEYS.mode);
    const mode: ThemeMode = m === "light" || m === "system" || m === "dark" ? m : "dark";
    const accent = localStorage.getItem(KEYS.accent) || "default";
    const s = localStorage.getItem(KEYS.scale);
    const scale: ScaleKey = s === "compact" || s === "large" ? s : "default";
    const reduceMotion = localStorage.getItem(KEYS.motion) === "reduce";
    return { mode, accent, scale, reduceMotion };
  } catch {
    return { ...DEFAULTS };
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;
}

export function effectiveDark(mode: ThemeMode): boolean {
  return mode === "system" ? systemPrefersDark() : mode === "dark";
}

export function applyAppearance(a: Appearance): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.classList.toggle("dark", effectiveDark(a.mode));
  el.classList.toggle("reduce-motion", a.reduceMotion);

  // The accent's real colors live in globals.css ([data-accent] + .dark[data-accent]); we
  // only flip the attribute. "default" = no attribute → the base monochrome tokens.
  const accent = a.accent && a.accent !== "default" && ACCENTS.some((x) => x.key === a.accent) ? a.accent : null;
  if (accent) el.setAttribute("data-accent", accent);
  else el.removeAttribute("data-accent");

  const scale = SCALES.find((x) => x.key === a.scale);
  if (scale && scale.px !== 16) el.style.fontSize = `${scale.px}px`;
  else el.style.removeProperty("font-size");
}

export interface AppearanceState extends Appearance {
  dark: boolean;
  setMode: (m: ThemeMode) => void;
  setAccent: (k: string) => void;
  setScale: (s: ScaleKey) => void;
  setReduceMotion: (v: boolean) => void;
  toggleDark: () => void;
}

export function useAppearance(): AppearanceState {
  const [a, setA] = useState<Appearance>(DEFAULTS);

  useEffect(() => {
    const sync = () => setA(read());
    sync();
    window.addEventListener(EVENT, sync);
    // When following the OS, repaint if the OS theme flips while the app is open.
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMq = () => {
      if (read().mode === "system") {
        applyAppearance(read());
        setA(read()); // also refresh state so the theme toggle's icon tracks the OS flip
      }
    };
    mq?.addEventListener?.("change", onMq);
    return () => {
      window.removeEventListener(EVENT, sync);
      mq?.removeEventListener?.("change", onMq);
    };
  }, []);

  function update(patch: Partial<Appearance>) {
    const next = { ...read(), ...patch };
    try {
      localStorage.setItem(KEYS.mode, next.mode);
      localStorage.setItem(KEYS.accent, next.accent);
      localStorage.setItem(KEYS.scale, next.scale);
      if (next.reduceMotion) localStorage.setItem(KEYS.motion, "reduce");
      else localStorage.removeItem(KEYS.motion);
    } catch {
      /* storage unavailable — appearance just won't persist */
    }
    applyAppearance(next);
    setA(next);
    window.dispatchEvent(new Event(EVENT)); // keep every other useAppearance() in sync
  }

  return {
    ...a,
    dark: effectiveDark(a.mode),
    setMode: (mode) => update({ mode }),
    setAccent: (accent) => update({ accent }),
    setScale: (scale) => update({ scale }),
    setReduceMotion: (reduceMotion) => update({ reduceMotion }),
    toggleDark: () => update({ mode: effectiveDark(a.mode) ? "light" : "dark" }),
  };
}
