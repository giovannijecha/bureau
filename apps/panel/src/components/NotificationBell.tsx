"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { listNotifications } from "../lib/api";
import { useEngineEvents } from "../lib/useEngineEvents";
import { cn } from "../lib/utils";

/** Header bell: shows the live unread count and links to the inbox. The count
 *  updates instantly when the engine pushes a `notification` WS event. */
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const { unread } = await listNotifications();
      if (alive.current) setUnread(unread);
    } catch {
      /* offline — leave the last known count */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEngineEvents((e) => {
    if (e.type === "notification" || e.type === "task_updated") void load();
  });

  return (
    <Link
      href="/notifications"
      className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title={unread > 0 ? `${unread} unread` : "Notifications"}
      aria-label="Notifications"
    >
      <Bell className="h-[18px] w-[18px]" />
      {unread > 0 && (
        <span className={cn("absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white")}>
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}
