import type { ServerWebSocket } from "bun";
import type { RpcCompatible, RpcTransport } from "capnweb";
import { RpcSession } from "capnweb";
import { Buffer } from "node:buffer";
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export function makeBunWebSocketRpcServer<T extends RpcCompatible<T>>(
  main: () => T,
) {
  if (typeof Bun === "undefined") {
    return makeNodeWebSocketRpcServer(main);
  }

  return Bun.serve<{
    transport: BunWebSocketRpcTransport;
    session: RpcSession<T>;
  }>({
    port: 0,
    fetch: (request, server) => {
      if (server.upgrade(request, { data: undefined! })) {
        return;
      }
      return new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      open: (ws) => {
        const transport = new BunWebSocketRpcTransport(ws);
        const session = new RpcSession<T>(transport, main());
        ws.data = { transport, session };
      },
      message: (ws, message) => {
        ws.data.transport.dispatchMessage(message);
      },
      close: (ws, code, reason) => {
        ws.data.transport.dispatchClose(code, reason);
      },
    },
  });
}

function makeNodeWebSocketRpcServer<T extends RpcCompatible<T>>(main: () => T) {
  const hostname = "127.0.0.1";
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const pendingUpgrades = new WeakMap<
    Request,
    { req: http.IncomingMessage; socket: any; head: Buffer }
  >();
  const wss = new WebSocketServer({ noServer: true });

  const server = {
    hostname,
    port,
    upgrade(request: Request, init: { data?: unknown } = {}) {
      const pending = pendingUpgrades.get(request);
      if (!pending) return false;
      pendingUpgrades.delete(request);

      wss.handleUpgrade(pending.req, pending.socket, pending.head, (ws) => {
        (ws as any).data = init.data;
        const transport = new NodeWebSocketRpcTransport(ws);
        const session = new RpcSession<T>(transport, main());
        (ws as any).data = { transport, session };
        ws.on("message", (message) => {
          transport.dispatchMessage(toNodeMessage(message));
        });
        ws.on("close", (code, reason) => {
          transport.dispatchClose(code, reason.toString());
        });
      });

      return true;
    },
    stop(force?: boolean) {
      return new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };
        for (const client of wss.clients) {
          force ? client.terminate() : client.close();
        }
        wss.close(done);
        httpServer.close(done);
        setTimeout(done, 100).unref?.();
      });
    },
  };

  const httpServer = http.createServer((_, response) => {
    response.statusCode = 400;
    response.end("Upgrade failed");
  });

  httpServer.on("upgrade", async (req, socket, head) => {
    const request = new Request(
      `http://${req.headers.host ?? hostname}${req.url}`,
      { headers: req.headers as HeadersInit },
    );
    pendingUpgrades.set(request, { req, socket, head });
    const response = await Promise.resolve(
      server.upgrade(request, { data: undefined }),
    );
    if (!response && pendingUpgrades.has(request)) {
      pendingUpgrades.delete(request);
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  httpServer.listen(port, hostname);
  return server;
}

function toNodeMessage(
  message: WebSocket.RawData,
): string | Buffer<ArrayBuffer> {
  if (typeof message === "string") return message;
  if (Buffer.isBuffer(message)) return message as Buffer<ArrayBuffer>;
  if (Array.isArray(message))
    return Buffer.concat(message) as Buffer<ArrayBuffer>;
  return Buffer.from(message) as Buffer<ArrayBuffer>;
}

class NodeWebSocketRpcTransport implements RpcTransport {
  private receiveQueue: Array<string> = [];
  private receiveResolver?: (value: string) => void;
  private receiveRejecter?: (reason: unknown) => void;
  private error?: unknown;

  constructor(private readonly ws: WebSocket) {}

  async send(message: string): Promise<void> {
    this.ws.send(message);
  }

  async receive(): Promise<string> {
    const next = this.receiveQueue.shift();
    if (next) {
      return next;
    } else if (this.error) {
      throw this.error;
    }
    return new Promise((resolve, reject) => {
      this.receiveResolver = resolve;
      this.receiveRejecter = reject;
    });
  }

  abort?(reason: any): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.ws.close(3000, message);
    this.error ??= reason;
  }

  dispatchMessage(data: string | Buffer<ArrayBuffer>): void {
    if (this.error) {
      return;
    }
    data = typeof data === "string" ? data : data.toString("utf-8");

    if (this.receiveResolver) {
      this.receiveResolver(data);
      this.receiveResolver = undefined;
      this.receiveRejecter = undefined;
    } else {
      this.receiveQueue.push(data);
    }
  }

  dispatchClose(code: number, reason: string): void {
    if (!this.error) {
      this.error = new Error(`WebSocket closed with code ${code}: ${reason}`);
      if (this.receiveRejecter) {
        this.receiveRejecter(this.error);
        this.receiveRejecter = undefined;
        this.receiveResolver = undefined;
      }
    }
  }
}

class BunWebSocketRpcTransport implements RpcTransport {
  private receiveQueue: Array<string> = [];
  private receiveResolver?: (value: string) => void;
  private receiveRejecter?: (reason: unknown) => void;
  private error?: unknown;
  constructor(private readonly ws: ServerWebSocket<any>) {}
  async send(message: string): Promise<void> {
    this.ws.send(message);
  }
  async receive(): Promise<string> {
    const next = this.receiveQueue.shift();
    if (next) {
      return next;
    } else if (this.error) {
      throw this.error;
    }
    return new Promise((resolve, reject) => {
      this.receiveResolver = resolve;
      this.receiveRejecter = reject;
    });
  }
  abort?(reason: any): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.ws.close(3000, message);
    this.error ??= reason;
  }
  dispatchMessage(data: string | Buffer<ArrayBuffer>): void {
    if (this.error) {
      return;
    }
    data = typeof data === "string" ? data : data.toString("utf-8");

    if (this.receiveResolver) {
      this.receiveResolver(data);
      this.receiveResolver = undefined;
      this.receiveRejecter = undefined;
    } else {
      this.receiveQueue.push(data);
    }
  }
  dispatchClose(code: number, reason: string): void {
    if (!this.error) {
      this.error = new Error(`WebSocket closed with code ${code}: ${reason}`);
      if (this.receiveRejecter) {
        this.receiveRejecter(this.error);
        this.receiveRejecter = undefined;
        this.receiveResolver = undefined;
      }
    }
  }
}
