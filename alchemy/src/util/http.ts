import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

export class HTTPServer {
  httpServer = http.createServer();
  webSocketServer?: WebSocketServer;

  constructor(options: {
    websocket?: (request: Request) => Promise<WebSocket>;
    fetch: (request: Request) => Promise<Response>;
  }) {
    this.httpServer.on("request", async (req, res) => {
      const response = await options.fetch(toWebRequest(req));
      await writeNodeResponse(res, response);
    });
    const websocket = options.websocket;
    if (websocket) {
      const webSocketServer = new WebSocketServer({ noServer: true });
      this.webSocketServer = webSocketServer;
      this.httpServer.on("upgrade", async (req, socket, head) => {
        const ws = await websocket(toWebRequest(req));
        coupleWebSocket(webSocketServer, req, socket, head, ws);
      });
    }
  }

  listen(port?: number) {
    return new Promise<this>((resolve, reject) => {
      this.httpServer.on("listening", () => {
        resolve(this);
      });
      this.httpServer.on("error", (error) => {
        reject(error);
      });
      this.httpServer.listen(port);
    });
  }

  get url() {
    const address = this.httpServer.address() as AddressInfo | null;
    if (!address) {
      throw new Error("Server is not listening");
    }
    const hostname = address.address === "::" ? "localhost" : address.address;
    return `http://${hostname}:${address.port}`;
  }

  async close() {
    const webSocketServer = this.webSocketServer;
    if (webSocketServer) {
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export function coupleWebSocket(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  server: WebSocket,
) {
  wss.handleUpgrade(req, socket, head, (client) => {
    client.on("message", (event, binary) => server.send(event, { binary }));
    client.on("close", (code, reason) => server.close(code, reason));
    server.on("message", (event, binary) => client.send(event, { binary }));
    server.on("close", (code, reason) => client.close(code, reason));
    wss.emit("connection", client, req);
  });
}

export function toWebRequest(
  req: http.IncomingMessage,
  host?: string,
): Request {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${host ?? req.headers.host}`);
  const body =
    ["GET", "HEAD", "OPTIONS"].includes(method) || !req.readable
      ? undefined
      : Readable.toWeb(req);
  return new Request(url.toString(), {
    method,
    headers: req.headers as Record<string, string>,
    body: body as unknown as BodyInit,
    // @ts-expect-error - caused by @cloudflare/workers-types
    duplex: body ? "half" : undefined,
    redirect: "manual",
  });
}

export async function writeNodeResponse(
  res: http.ServerResponse,
  response: Response,
) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (response.body) {
    await response.body.pipeTo(
      new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        },
      }),
    );
  } else {
    res.end();
  }
}
