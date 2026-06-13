// WebSocket hub — broadcasts WsEvents from the engine to every connected panel.

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { WsEvent } from "@bureau/contracts";
import type { EventSink } from "./ports.js";

export class WsHub implements EventSink {
  private readonly wss: WebSocketServer;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
  }

  emit(event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  close(): void {
    this.wss.close();
  }
}
