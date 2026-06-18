"use client";

// Header bell → a centered INBOX MODAL (no separate page, no corner dropdown). Backdrop +
// blur, Escape / click-outside to close — the same modal language as ConfirmDialog. Live
// unread count, mark-read / mark-all-read, and click-through to the task.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Bell, CircleDot, GitMerge, XCircle, AlertTriangle, CheckCheck, ArrowRight, X, type LucideIcon } from "lucide-react";
import type { Notification } from "@bureau/contracts";
import { listNotifications, markNotificationRead, markAllNotificationsRead } from "../lib/api";
import { useEngineEvents } from "../lib/useEngineEvents";
import { cn } from "../lib/utils";

const META: Record<string, { icon: LucideIcon; tint: string; ring: string }> = {
  review: { icon: CircleDot, tint: "text-amber-500", ring: "bg-amber-500/10" },
  merged: { icon: GitMerge, tint: "text-green-500", ring: "bg-green-500/10" },
  failed: { icon: XCircle, tint: "text-red-500", ring: "bg-red-500/10" },
  merge_failed: { icon: AlertTriangle, tint: "text-red-500", ring: "bg-red-500/10" },
};

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await listNotifications();
      if (alive.current) {
        setItems(res.items);
        setUnread(res.unread);
      }
    } catch {
      /* offline — keep the last known state */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEngineEvents((e) => {
    if (e.type === "notification" || e.type === "task_updated") void load();
  });

  async function readOne(id: string) {
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? "now" } : n)) ?? prev);
    setUnread((u) => Math.max(0, u - 1));
    try {
      await markNotificationRead(id);
    } catch {
      void load();
    }
  }

  async function readAll() {
    setItems((prev) => prev?.map((n) => ({ ...n, readAt: n.readAt ?? "now" })) ?? prev);
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      void load();
    }
  }

  function openItem(n: Notification) {
    if (n.readAt === null) void readOne(n.id);
    if (n.taskId) {
      setOpen(false);
      router.push(`/tasks/${n.taskId}`);
    }
  }

  return (
    <>
      <button
        onClick={() => {
          if (!open) void load(); // refresh on open
          setOpen((o) => !o);
        }}
        className={cn(
          "relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground"
        )}
        title={unread > 0 ? `${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Notifications"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <NotificationsModal
          items={items}
          unread={unread}
          onClose={() => setOpen(false)}
          onReadOne={readOne}
          onReadAll={readAll}
          onOpenItem={openItem}
        />
      )}
    </>
  );
}

function NotificationsModal({
  items,
  unread,
  onClose,
  onReadOne,
  onReadAll,
  onOpenItem,
}: {
  items: Notification[] | null;
  unread: number;
  onClose: () => void;
  onReadOne: (id: string) => void;
  onReadAll: () => void;
  onOpenItem: (n: Notification) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const list = items ?? [];

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    // Keep the page behind from scrolling under the modal (the app scrolls inner panes,
    // so block wheel/touch that lands on the backdrop rather than inside the card).
    const overlay = overlayRef.current;
    const stopScroll = (e: Event) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) e.preventDefault();
    };
    overlay?.addEventListener("wheel", stopScroll, { passive: false });
    overlay?.addEventListener("touchmove", stopScroll, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      overlay?.removeEventListener("wheel", stopScroll);
      overlay?.removeEventListener("touchmove", stopScroll);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="animate-overlay-in fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        tabIndex={-1}
        className="animate-dialog-in flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl outline-none"
      >
        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-3.5">
          <h2 className="text-base font-semibold">Notifications</h2>
          {unread > 0 && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500">{unread} new</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {unread > 0 && (
              <button
                onClick={() => onReadAll()}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items === null ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</p>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-5 py-14 text-center text-sm text-muted-foreground">
              <Bell className="h-7 w-7 opacity-40" />
              You&apos;re all caught up. Bureau pings you here when a task needs review, merges, or fails.
            </div>
          ) : (
            <ul className="divide-y">
              {list.map((n) => {
                const meta = META[n.kind] ?? { icon: Bell, tint: "text-muted-foreground", ring: "bg-muted" };
                const Icon = meta.icon;
                const isUnread = n.readAt === null;
                return (
                  <li key={n.id} className={cn("group relative transition-colors hover:bg-muted/40", isUnread && "bg-primary/[0.04]")}>
                    <button onClick={() => onOpenItem(n)} className="flex w-full items-start gap-3 px-5 py-3.5 text-left">
                      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", meta.ring)}>
                        <Icon className={cn("h-[18px] w-[18px]", meta.tint)} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{n.subject}</span>
                          {isUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                        </div>
                        <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>
                        {n.taskId && (
                          <span className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary">
                            {n.kind === "review" ? "Review & merge" : "Open task"} <ArrowRight className="h-3 w-3" />
                          </span>
                        )}
                      </div>
                    </button>
                    {isUnread && (
                      <button
                        onClick={() => onReadOne(n.id)}
                        title="Mark read"
                        aria-label="Mark read"
                        className="absolute right-3 top-3.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
