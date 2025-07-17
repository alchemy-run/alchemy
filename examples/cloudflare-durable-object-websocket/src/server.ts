import { DurableObject } from "cloudflare:workers";
import type { server } from "../alchemy.run.ts";

export default {
  fetch: (req, env) => {
    const stub = env.WS_SERVER.get(env.WS_SERVER.idFromName("default"));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<typeof server.Env>;

export class WebSocketServer extends DurableObject {
  async fetch(req: Request) {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Not a websocket request", { status: 400 });
    }
    const wsPair = new WebSocketPair();
    const { 0: client, 1: server } = wsPair;
    this.ctx.acceptWebSocket(server);
    console.log("accepting websocket request");
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): void | Promise<void> {
    console.log("message", message);
    ws.send(message);
  }

  webSocketClose(
    _ws: WebSocket,
    code: number,
    reason: string,
  ): void | Promise<void> {
    console.log("close", code, reason);
  }

  webSocketError(_ws: WebSocket, error: unknown): void | Promise<void> {
    console.log("error", error);
  }
}
