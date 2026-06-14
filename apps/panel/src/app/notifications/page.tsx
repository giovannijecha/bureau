"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CircleDot, GitMerge, XCircle, AlertTriangle, CheckCheck, ArrowRight, type LucideIcon } from "lucide-react";
import type { Notification } from "@bureau/contracts";
import { listNotifications, markNotificationRead, markAllNotificationsRead } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

const META: Record<string, { icon: LucideIcon; tint: string; ring: string }> = {
  review: { icon: CircleDot, tint: "text-amber-500", ring: "bg-amber-500/10" },
  merged: { icon: GitMerge, tint: "text-green-500", ring: "bg-green-500/10" },
  failed: { icon: XCircle, tint: "text-red-500", ring: "bg-red-500/10" },
  merge_failed: { icon: AlertTriangle, tint: "text-red-500", ring: "bg-red-500/10" },
};

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const { items } = await listNotifications();
      if (alive.current) setItems(items);
    } catch {
      if (alive.current) setItems([]);
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
    try {
      await markNotificationRead(id);
    } catch {
      void load();
    }
  }

  async function readAll() {
    setItems((prev) => prev?.map((n) => ({ ...n, readAt: n.readAt ?? "now" })) ?? prev);
    try {
      await markAllNotificationsRead();
    } catch {
      void load();
    }
  }

  const list = items ?? [];
  const unread = list.filter((n) => n.readAt === null).length;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {unread > 0 ? `${unread} unread` : "You're all caught up."}
          </p>
          {unread > 0 && (
            <button
              onClick={() => void readAll()}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          )}
        </div>

        {items === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
            <Bell className="h-6 w-6 opacity-40" />
            No notifications yet. Bureau will tell you here when a task is ready for review, merges, or fails.
          </div>
        ) : (
          <ul className="space-y-2">
            {list.map((n) => {
              const meta = META[n.kind] ?? { icon: Bell, tint: "text-muted-foreground", ring: "bg-muted" };
              const Icon = meta.icon;
              return (
                <li
                  key={n.id}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors",
                    n.readAt === null && "border-primary/30 bg-primary/[0.03]"
                  )}
                >
                  <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", meta.ring)}>
                    <Icon className={cn("h-[18px] w-[18px]", meta.tint)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{n.subject}</span>
                      {n.readAt === null && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>
                    <div className="mt-2 flex items-center gap-3 text-xs">
                      {n.taskId && (
                        <Link href={`/tasks/${n.taskId}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                          {n.kind === "review" ? "Review & merge" : "Open task"} <ArrowRight className="h-3 w-3" />
                        </Link>
                      )}
                      {n.readAt === null && (
                        <button onClick={() => void readOne(n.id)} className="text-muted-foreground transition-colors hover:text-foreground">
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
