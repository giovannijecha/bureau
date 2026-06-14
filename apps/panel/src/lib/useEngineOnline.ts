"use client";

// Poll the engine's /health so the panel can show a live connection indicator.
import { useEffect, useState } from "react";
import { ENGINE_URL } from "./api";

export function useEngineOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const res = await fetch(`${ENGINE_URL}/health`);
        if (alive) setOnline(res.ok);
      } catch {
        if (alive) setOnline(false);
      }
    }
    void check();
    const t = setInterval(check, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return online;
}
