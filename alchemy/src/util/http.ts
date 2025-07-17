import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export class HTTPServer {
  httpServer: http.Server;

  constructor(options: {
    fetch: (request: Request) => Promise<Response>;
  }) {
    this.httpServer = http.createServer();
    this.httpServer.on("request", async (req, res) => {
      const response = await options.fetch(toWebRequest(req));
      await writeNodeResponse(res, response);
    });
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

  close() {
    return new Promise((resolve, reject) => {
      this.httpServer.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  }
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
