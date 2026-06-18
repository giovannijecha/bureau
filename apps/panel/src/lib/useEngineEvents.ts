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
 * `onReconnect` fires on every RE-connect (not the first open): WS frames emitted while
 * the socket was down are NOT replayed, so a consumer that mirrors engine state should
 * re-sync (re-fetch) on reconnect to heal anything missed during the gap.
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
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);
}
