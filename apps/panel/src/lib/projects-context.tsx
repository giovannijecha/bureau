"use client";

// The repositories Bureau works on + the active selection, shared across the WHOLE app
// via context so a switch in one place (the global header switcher, a composer picker)
// re-scopes every mounted page LIVE — not only after a reload. The active id persists in
// localStorage so it survives reloads. One fetch for the app, not one per consumer.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Project } from "@bureau/contracts";
import { listProjects } from "./api";

const KEY = "bureau.activeProject";

export interface ProjectsState {
  projects: Project[];
  active: Project | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  error: string | null;
}

const ProjectsContext = createContext<ProjectsState | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listProjects()
      .then((ps) => {
        if (!alive) return;
        setProjects(ps);
        const saved = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
        setActiveIdState(ps.find((p) => p.id === saved)?.id ?? ps[0]?.id ?? null);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, id);
  }, []);

  const active = projects.find((p) => p.id === activeId) ?? null;
  return (
    <ProjectsContext.Provider value={{ projects, active, activeId, setActiveId, error }}>{children}</ProjectsContext.Provider>
  );
}

export function useProjects(): ProjectsState {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("useProjects must be used within a <ProjectsProvider>");
  return ctx;
}
