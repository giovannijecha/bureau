"use client";

// Shared sidebar state for the whole panel shell. Two orthogonal concerns:
//  • collapsed — the DESKTOP icon-only rail, persisted to localStorage so the
//    choice survives reloads.
//  • drawerOpen — the MOBILE off-canvas drawer, ephemeral (always starts closed,
//    auto-closes on navigation). Header (hamburger / toggle) and Sidebar share it.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "bureau.sidebar.collapsed";

export interface SidebarState {
  /** Desktop icon-only rail (persisted). */
  collapsed: boolean;
  /** Mobile off-canvas drawer (ephemeral). */
  drawerOpen: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
  openDrawer: () => void;
  closeDrawer: () => void;
}

const NOOP: SidebarState = {
  collapsed: false,
  drawerOpen: false,
  toggleCollapsed: () => {},
  setCollapsed: () => {},
  openDrawer: () => {},
  closeDrawer: () => {},
};

const SidebarContext = createContext<SidebarState | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Load the persisted desktop preference once on mount (client-only).
  useEffect(() => {
    try {
      setCollapsedState(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* localStorage unavailable — keep expanded */
    }
  }, []);

  // Tapped a nav link / route changed → close the mobile drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const persist = (v: boolean): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
    persist(v);
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      persist(next);
      return next;
    });
  }, []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <SidebarContext.Provider value={{ collapsed, drawerOpen, toggleCollapsed, setCollapsed, openDrawer, closeDrawer }}>
      {children}
    </SidebarContext.Provider>
  );
}

/** Sidebar shell state. Returns inert no-ops outside the provider (never throws). */
export function useSidebar(): SidebarState {
  return useContext(SidebarContext) ?? NOOP;
}
