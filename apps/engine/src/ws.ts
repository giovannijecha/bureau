// WebSocket hub — broadcasts WsEvents from the engine to every connected panel.
//
// Uses `noServer: true`: multiple WebSocketServers can't each own the HTTP server's
// `upgrade` event (the first to run would abortHandshake on a path it doesn't own).
// server.ts routes upgrades by path to this hub (/ws) or the terminal (/terminal).

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WsEvent } from "@bureau/contracts";
import type { EventSink } from "./ports.js";

export class WsHub implements EventSink {
  private readonly wss: WebSocketServer;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Complete a WebSocket handshake routed here by the server's upgrade dispatcher. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  emit(event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  close(): void {
    // A noServer WebSocketServer's close() does NOT drop open sockets — terminate
    // them first so a panel's permanent /ws connection doesn't keep the event loop
    // alive and force the shutdown hard-kill.
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
