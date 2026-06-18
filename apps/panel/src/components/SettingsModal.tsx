"use client";

// Settings as a centered MODAL (Claude-style) instead of a full-page navigation — opened
// from the sidebar, it keeps you in context. The same <SettingsBody/> still backs the
// real /settings route (deep-link / fallback), so there's one source of truth for the UI.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, Settings } from "lucide-react";
import { SettingsBody } from "../app/settings/SettingsBody";
import { pushModalLayer, popModalLayer, isTopModalLayer } from "../lib/modal-stack";

interface SettingsModalCtx {
  /** Open Settings, optionally jumping straight to a section (e.g. "projects"). */
  open: (section?: string) => void;
  close: () => void;
  isOpen: boolean;
}

const Ctx = createContext<SettingsModalCtx | null>(null);

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [section, setSection] = useState<string | undefined>(undefined);
  const open = useCallback((s?: string) => {
    setSection(s);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  return (
    <Ctx.Provider value={{ open, close, isOpen }}>
      {children}
      {isOpen && <SettingsModal onClose={close} initialSection={section} />}
    </Ctx.Provider>
  );
}

export function useSettingsModal(): SettingsModalCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettingsModal must be used within a SettingsModalProvider");
  return ctx;
}

function SettingsModal({ onClose, initialSection }: { onClose: () => void; initialSection?: string | undefined }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const layer = pushModalLayer();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus(); // move focus into the dialog so keyboard nav starts here
    const onKey = (e: KeyboardEvent) => {
      // Only close if we're the top-most layer — a nested confirm handles its own Escape.
      if (e.key === "Escape" && isTopModalLayer(layer)) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      popModalLayer(layer);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      previouslyFocused?.focus?.(); // restore focus to the sidebar Settings button
    };
  }, [onClose]);

  // Keep Tab focus within the dialog (the page behind is inert under the backdrop).
  function onDialogKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const f = dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!f || f.length === 0) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const a = document.activeElement;
    if (e.shiftKey && a === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && a === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="animate-overlay-in fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onKeyDown={onDialogKeyDown}
        className="animate-dialog-in flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Settings className="h-[18px] w-[18px]" />
            </div>
            <h2 className="text-[15px] font-semibold tracking-tight">Settings</h2>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <SettingsBody initialSection={initialSection} />
        </div>
      </div>
    </div>,
    document.body
  );
}
