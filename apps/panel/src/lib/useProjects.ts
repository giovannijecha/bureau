"use client";

// The repositories Bureau works on, plus the one the CEO has selected. The active
// selection persists in localStorage so it survives reloads.

import { useCallback, useEffect, useState } from "react";
import type { Project } from "@bureau/contracts";
import { listProjects } from "./api";

const KEY = "bureau.activeProject";

export interface UseProjects {
  projects: Project[];
  active: Project | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  error: string | null;
}

export function useProjects(): UseProjects {
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
  return { projects, active, activeId, setActiveId, error };
}
