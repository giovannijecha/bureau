"use client";

// A tiny, dependency-free toast system: ephemeral feedback for actions that would
// otherwise be silent (a copy, a created task, a failed request). One provider mounted
// at the app root exposes useToast(); the stack renders bottom-right via a portal so it
// floats over any page or modal. Auto-dismisses; errors linger a little longer.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { cn } from "../lib/utils";

type Variant = "success" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: Variant;
}

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: Variant;
  /** Override the auto-dismiss delay (ms). */
  duration?: number;
}

const ToastContext = createContext<((o: ToastOptions) => void) | null>(null);

const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (o: ToastOptions) => {
      const id = ++seq.current;
      const item: ToastItem = { id, title: o.title, variant: o.variant ?? "info", ...(o.description ? { description: o.description } : {}) };
      // Keep the stack bounded — drop the oldest when a new one would exceed the cap.
      setToasts((ts) => [...ts.slice(-(MAX_VISIBLE - 1)), item]);
      const duration = o.duration ?? (o.variant === "error" ? 6000 : 3500);
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/** Returns the raw `toast(opts)` plus success/error/info convenience helpers. */
export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used within a <ToastProvider>");
  return {
    toast,
    success: (title: string, description?: string) => toast({ title, variant: "success", ...(description ? { description } : {}) }),
    error: (title: string, description?: string) => toast({ title, variant: "error", ...(description ? { description } : {}) }),
    info: (title: string, description?: string) => toast({ title, variant: "info", ...(description ? { description } : {}) }),
  };
}

const ICON: Record<Variant, typeof CheckCircle2> = { success: CheckCircle2, error: XCircle, info: Info };
const ACCENT: Record<Variant, string> = {
  success: "text-green-500",
  error: "text-destructive",
  info: "text-primary",
};

function Toaster({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  // Render the aria-live region ALWAYS (only the children are conditional) so a screen
  // reader is already observing it when the first toast arrives — otherwise the very first
  // announcement can be dropped. Only the SSR no-DOM case bails.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => {
        const Icon = ICON[t.variant];
        return (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            className="animate-toast-in pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg"
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", ACCENT[t.variant])} />
            <div className="min-w-0 flex-1">
              <div className="font-medium leading-snug">{t.title}</div>
              {t.description && <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{t.description}</div>}
            </div>
            <button
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body
  );
}
