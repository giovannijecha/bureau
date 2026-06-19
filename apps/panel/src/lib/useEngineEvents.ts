"use client";

// Subscribe to the engine's live event stream (WebSocket /ws). The engine pushes
// WsEvents as tasks advance — step_started/completed, gate_opened, task_updated,
// iris_message — so the panel can reflect progress live instead of polling.

import { useEffect, useRef } from "react";
import type { WsEvent } from "@bureau/contracts";

const WS_URL = (process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4319").replace(/^http/, "ws") + "/ws";

/**
 * Call `onEvent` for every event the engine pushes. Auto-reconnects on drop.
 *
 * `onReconnect` fires on every RE-connect (not the first open) AND whenever the tab becomes
 * visible/focused again. WS frames emitted while the socket was down — or while a background
 * tab was throttled/suspended — are NOT replayed, so a consumer that mirrors engine state
 * should pass `onReconnect` to re-fetch and heal anything missed. (Backgrounded tabs commonly
 * leave a "zombie" socket that never fires onclose; on return we force a reconnect if it's
 * not live, so live updates resume too.)
 */
export function useEngineEvents(onEvent: (event: WsEvent) => void, onReconnect?: () => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let everOpened = false;

    function connect(): void {
      if (disposed) return;
      socket = new WebSocket(WS_URL);
      socket.onopen = () => {
        if (everOpened) reconnect.current?.(); // re-sync after a drop (missed frames aren't replayed)
        everOpened = true;
      };
      socket.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data as string) as WsEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        if (!disposed) retry = setTimeout(connect, 1500); // reconnect with a small backoff
      };
      socket.onerror = () => socket?.close();
    }

    connect();

    // Tab-return / refocus. A backgrounded tab can miss WS frames or leave a zombie socket
    // that never fired onclose (→ no reconnect, no re-sync). On becoming visible: force a
    // reconnect if the socket isn't live (live updates resume), else just re-sync. Either
    // path heals the state the panel may have missed while hidden.
    const onVisible = (): void => {
      if (disposed || document.visibilityState !== "visible") return;
      const live = socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
      if (!live) {
        if (retry) clearTimeout(retry);
        connect(); // its onopen fires onReconnect (everOpened is already true) → re-sync
      } else {
        reconnect.current?.(); // socket's fine, but throttled frames may have been dropped
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      socket?.close();
    };
  }, []);
}
