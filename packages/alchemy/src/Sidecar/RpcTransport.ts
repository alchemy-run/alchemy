import type { ServerWebSocket } from "bun";
import type { RpcCompatible, RpcTransport } from "capnweb";
import { RpcSession } from "capnweb";

export function makeBunWebSocketRpcServer<T extends RpcCompatible<T>>(
  main: () => T,
) {
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
