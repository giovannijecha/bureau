"use client";

// The repositories Bureau works on + the active selection, shared across the WHOLE app
// via context so a switch in one place (the global header switcher, a composer picker)
// re-scopes every mounted page LIVE — not only after a reload. The active id persists in
// localStorage so it survives reloads. One fetch for the app, not one per consumer. The
// list refreshes on add/remove (a `projects_changed` engine event), reconciling the active
// id so a removed project never dangles.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Project } from "@bureau/contracts";
import { listProjects } from "./api";
import { useEngineEvents } from "./useEngineEvents";

const KEY = "bureau.activeProject";

export interface ProjectsState {
  projects: Project[];
  active: Project | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  /** Re-fetch the project list (after an add/remove) and reconcile the active id. */
  refresh: () => void;
  error: string | null;
}

const ProjectsContext = createContext<ProjectsState | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const ps = await listProjects();
      setProjects(ps);
      setError(null);
      // Keep the current active id if it still exists; else fall back to the saved one,
      // else the first project (so a removed-active never leaves the app unscoped).
      setActiveIdState((cur) => {
        if (cur && ps.some((p) => p.id === cur)) return cur;
        const saved = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
        const next = ps.find((p) => p.id === saved)?.id ?? ps[0]?.id ?? null;
        if (next && typeof window !== "undefined") window.localStorage.setItem(KEY, next);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The engine signals add/remove (incl. from another tab) — refetch live.
  useEngineEvents((e) => {
    if (e.type === "projects_changed") void refresh();
  });

  const active = projects.find((p) => p.id === activeId) ?? null;
  return (
    <ProjectsContext.Provider value={{ projects, active, activeId, setActiveId, refresh: () => void refresh(), error }}>
      {children}
    </ProjectsContext.Provider>
  );
}

export function useProjects(): ProjectsState {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("useProjects must be used within a <ProjectsProvider>");
  return ctx;
}
