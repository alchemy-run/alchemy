import type http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { HTTPServer } from "../../util/http.ts";

export interface MiniflareWorkerProxyOptions {
  /**
   * Used to proxy websocket connections to the worker.
   * (This is a hack; used because trying to interact with `response.webSocket` doesn't work on Bun.)
   */
  getDirectURL: () => Promise<URL>;
  /** Used to proxy HTTP requests to the worker. */
  fetch: (request: Request) => Promise<Response>;
}

export class MiniflareWorkerProxy extends HTTPServer {
  wsServer: WebSocketServer;
  wsReconnectAttempts = new Map<string, number>();

  constructor(private readonly options: MiniflareWorkerProxyOptions) {
    super({
      fetch: options.fetch,
    });
    this.wsServer = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", async (req, socket, head) => {
      this.wsServer.handleUpgrade(req, socket, head, async (client) => {
        const id = crypto.randomUUID();
        await this.handleUpgrade(id, client, req);
      });
    });
  }

  private async handleUpgrade(
    id: string,
    client: WebSocket,
    request: http.IncomingMessage,
  ) {
    const attempt = this.wsReconnectAttempts.get(id) ?? 0;
    this.wsReconnectAttempts.set(id, attempt + 1);
    if (attempt > 3) {
      client.close(1006, "Too many reconnect attempts");
      return;
    }
    if (attempt > 0) {
      const delay = attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const target = await this.options.getDirectURL();
    const url = new URL(request.url ?? "/", target);
    const headers = { ...request.headers };
    // All of these headers are set by the WebSocket constructor,
    // so if we don't delete them, the request will fail.
    delete headers.host;
    delete headers.connection;
    delete headers.upgrade;
    delete headers["sec-websocket-version"];
    delete headers["sec-websocket-key"];
    delete headers["sec-websocket-protocol"];
    delete headers["sec-websocket-extensions"];
    delete headers["sec-websocket-accept"];
    const server = new WebSocket(url.toString(), {
      protocol: request.headers["sec-websocket-protocol"],
      key: request.headers["sec-websocket-key"],
      headers,
    });
    server.on("open", () => {
      // Reset the reconnect attempts when the connection is established successfully.
      this.wsReconnectAttempts.set(id, 0);
    });
    server.on("message", (data, binary) => {
      client.send(data, { binary });
    });
    server.on("close", async (code, reason) => {
      if (code === 1006) {
        // When the worker hot reloads, the websocket connection is closed with this code.
        // Reconnecting allows the client to maintain the same connection.
        await this.handleUpgrade(id, client, request);
        return;
      }
      client.close(code, reason);
    });
    client.on("message", (data, binary) => {
      server.send(data, { binary });
    });
    client.on("close", (code, reason) => {
      this.wsReconnectAttempts.delete(id);
      if (server.readyState === WebSocket.OPEN) {
        server.close(code, reason);
      }
    });
  }

  async close() {
    this.wsServer.close();
    await super.close();
  }
}
