"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { pushModalLayer, popModalLayer, isTopModalLayer } from "../lib/modal-stack";
import { cn } from "../lib/utils";

export type ConfirmVariant = "destructive" | "default";

export interface ConfirmOptions {
  /** Short question, e.g. "Delete conversation?" */
  title: string;
  /** One or two sentences spelling out the consequence. */
  description?: string;
  /** Label for the affirmative button (default: "Confirm"). */
  confirmLabel?: string;
  /** Label for the dismissive button (default: "Cancel"). */
  cancelLabel?: string;
  /** "destructive" (red) for irreversible actions; "default" (primary) otherwise. */
  variant?: ConfirmVariant;
}

type Resolver = (ok: boolean) => void;

// Outside a provider the hook resolves to `false` (acts like a declined confirm)
// so a stray call can never silently run a destructive action.
const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));

/** `const confirm = useConfirm(); if (await confirm({...})) { ... }` — a themed,
 *  promise-based replacement for the browser's native `window.confirm()`. */
export function useConfirm() {
  return useContext(ConfirmContext);
}

/** Mount once near the app root. Holds the single active confirm request and
 *  renders the modal into a portal on `document.body`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const [mounted, setMounted] = useState(false);
  const resolverRef = useRef<Resolver | null>(null);
  const pathname = usePathname();

  // Portals need the DOM — only render on the client after first mount.
  useEffect(() => setMounted(true), []);

  const close = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null; // null first → idempotent under React StrictMode double-invokes
    setPending(null);
    resolve?.(ok);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // If a request is somehow already open, decline it before replacing.
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setPending(opts);
      }),
    []
  );

  // A pending confirm is bound to the page that opened it. On client-side
  // navigation that page unmounts but this provider (in the layout) does not —
  // so auto-decline, or the modal would float over an unrelated page and
  // confirming it would fire the original page's (possibly destructive) action.
  useEffect(() => {
    if (resolverRef.current) close(false);
  }, [pathname, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {mounted && pending && createPortal(<ConfirmModal pending={pending} onClose={close} />, document.body)}
    </ConfirmContext.Provider>
  );
}

function ConfirmModal({ pending, onClose }: { pending: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const variant = pending.variant ?? "destructive";

  useEffect(() => {
    // Move focus into the dialog (the affirmative button) and remember where it
    // came from so we can restore it when the dialog closes.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    // This confirm may be stacked ABOVE another modal (e.g. the Settings modal). Register
    // a layer so a single Escape closes only the top-most one, not every layer at once.
    const layer = pushModalLayer();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!isTopModalLayer(layer)) return;
        e.preventDefault();
        onClose(false);
        return;
      }
      // Trap Tab focus inside the dialog (WAI-ARIA alertdialog). The Tab handler is scoped
      // to THIS dialog's focusables, so it's correct even when stacked over another modal.
      if (e.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);

    // Lock background scroll: the app's real scroll containers are inner
    // `overflow-y-auto` panes, so toggling body overflow is a no-op here — block
    // wheel/touch that lands outside the dialog card instead. Non-passive so
    // preventDefault actually takes effect.
    const overlay = overlayRef.current;
    const stopScroll = (e: Event) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) e.preventDefault();
    };
    overlay?.addEventListener("wheel", stopScroll, { passive: false });
    overlay?.addEventListener("touchmove", stopScroll, { passive: false });

    return () => {
      popModalLayer(layer);
      window.removeEventListener("keydown", onKey);
      overlay?.removeEventListener("wheel", stopScroll);
      overlay?.removeEventListener("touchmove", stopScroll);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const Icon = variant === "destructive" ? AlertTriangle : HelpCircle;

  return (
    <div
      ref={overlayRef}
      className="animate-overlay-in fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/60 p-4 backdrop-blur-sm"
      // Click on the backdrop (not the card) dismisses. mousedown, so a drag that
      // starts inside the card and ends on the backdrop doesn't accidentally close.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={pending.description ? "confirm-desc" : undefined}
        className="animate-dialog-in w-full max-w-md rounded-xl border bg-card p-5 shadow-2xl"
      >
        <div className="flex gap-3.5">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              variant === "destructive" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id="confirm-title" className="text-base font-semibold leading-snug">
              {pending.title}
            </h2>
            {pending.description && (
              <p id="confirm-desc" className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {pending.description}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="inline-flex h-9 items-center rounded-md border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            {pending.cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={confirmRef}
            onClick={() => onClose(true)}
            className={cn(
              "inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium transition-colors",
              variant === "destructive"
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
