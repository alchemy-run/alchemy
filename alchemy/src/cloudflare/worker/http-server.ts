import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export class HTTPServer {
  server: http.Server;
  constructor(options: {
    port?: number;
    fetch: (request: Request) => Promise<Response>;
  }) {
    this.server = http
      .createServer(async (req, res) => {
        const response = await options.fetch(toWebRequest(req));
        await writeNodeResponse(res, response);
      })
      .listen(options.port);
  }

  get port() {
    return (this.server.address() as AddressInfo).port;
  }

  get hostname() {
    return (this.server.address() as AddressInfo).address;
  }

  stop() {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  }
}

function toWebRequest(request: http.IncomingMessage): Request {
  const method = request.method ?? "GET";
  return new Request(`http://${request.headers.host}${request.url ?? "/"}`, {
    method,
    headers: request.headers as Record<string, string>,
    body:
      ["GET", "HEAD", "OPTIONS"].includes(method) || !request.readable
        ? undefined
        : (Readable.toWeb(request) as unknown as BodyInit),
  });
}

async function writeNodeResponse(res: http.ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  await response.body?.pipeTo(
    new WritableStream({
      write(chunk) {
        res.write(chunk);
      },
      close() {
        res.end();
      },
    }),
  );
  res.end();
}
