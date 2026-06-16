"use client";

// Single source of truth for the light/dark theme. The class on <html> and the
// `bureau.theme` localStorage key are the shared state; every useTheme() instance
// (Header toggle, Settings preference) stays in sync via a custom window event, so
// changing the theme in one place updates the others live — no reload needed.

import { useEffect, useState } from "react";

const KEY = "bureau.theme";
const EVENT = "bureau-theme-change";

function readDark(): boolean {
  try {
    const saved = window.localStorage.getItem(KEY);
    return saved ? saved === "dark" : true;
  } catch {
    return true;
  }
}

export interface ThemeState {
  dark: boolean;
  setDark: (v: boolean) => void;
  toggle: () => void;
}

export function useTheme(): ThemeState {
  const [dark, setDarkState] = useState(true);

  useEffect(() => {
    setDarkState(readDark());
    const sync = (): void => setDarkState(document.documentElement.classList.contains("dark"));
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);

  const setDark = (v: boolean): void => {
    setDarkState(v);
    document.documentElement.classList.toggle("dark", v);
    try {
      window.localStorage.setItem(KEY, v ? "dark" : "light");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(EVENT)); // keep every other useTheme() in sync
  };

  return { dark, setDark, toggle: () => setDark(!dark) };
}
