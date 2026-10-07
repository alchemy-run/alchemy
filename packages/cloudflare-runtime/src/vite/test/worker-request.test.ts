import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import { URL as NodeURL } from "node:url";
import * as vite from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardWorkerRequest } from "../worker-request.ts";

const servers: Array<NodeHttp.Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

const listen = (handler: NodeHttp.RequestListener) =>
  new Promise<{ server: NodeHttp.Server; url: string }>((resolve, reject) => {
    const server = NodeHttp.createServer(handler);
    servers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });

/** Counts the TCP connections a server accepts. */
const countConnections = (server: NodeHttp.Server) => {
  const count = { value: 0 };
  server.on("connection", () => count.value++);
  return count;
};

/**
 * A Vite-like server whose every request is forwarded to `worker`. `before`
 * runs ahead of the forward, the way earlier middlewares do.
 */
const proxyTo = async (
  worker: string,
  before?: (req: NodeHttp.IncomingMessage) => Promise<void>,
) => {
  const logger = { ...vite.createLogger("silent"), error: vi.fn() };
  const proxy = await listen(async (req, res) => {
    await before?.(req);
    forwardWorkerRequest(req, res, new NodeURL(req.url ?? "/", worker), "secret", logger);
  });
  return { ...proxy, logger };
};

/** One request over `agent`, resolving with the response and its body. */
const send = (url: string, options: NodeHttp.RequestOptions = {}, body?: string) =>
  new Promise<{ response: NodeHttp.IncomingMessage; body: string }>((resolve, reject) => {
    const request = NodeHttp.request(url, options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ response, body: text }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });

describe("forwardWorkerRequest", () => {
  it("forwards the request and relays the Worker's response", async () => {
    const worker = await listen((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        res.writeHead(201, { "x-worker": "yes" });
        res.end(`${req.method} ${req.url} ${body}`);
      });
    });
    const proxy = await proxyTo(worker.url);

    const { response, body } = await send(`${proxy.url}/path?q=1`, { method: "POST" }, "hello");

    expect(response.statusCode).toBe(201);
    expect(response.headers["x-worker"]).toBe("yes");
    expect(body).toBe("POST /path?q=1 hello");
    expect(proxy.logger.error).not.toHaveBeenCalled();
  });

  it("does not reuse a connection the Worker may be closing", async () => {
    // workerd closes an idle connection after 5s and a connection whose
    // response it cut short, with nothing telling the client in advance. This
    // stand-in closes every connection when a second request arrives on it,
    // so any reuse fails.
    const served = new WeakSet<object>();
    const worker = await listen((req, res) => {
      if (served.has(req.socket)) {
        req.socket.destroy();
        return;
      }
      served.add(req.socket);
      res.end("worker");
    });
    const proxy = await proxyTo(worker.url);

    for (let i = 0; i < 3; i++) {
      const { response, body } = await send(proxy.url);
      expect(response.statusCode).toBe(200);
      expect(body).toBe("worker");
    }
    expect(proxy.logger.error).not.toHaveBeenCalled();
  });

  it("keeps the client's connection alive while closing the Worker's after each response", async () => {
    const worker = await listen((req, res) => res.end(req.headers.connection));
    const workerConnections = countConnections(worker.server);
    const proxy = await proxyTo(worker.url);
    const proxyConnections = countConnections(proxy.server);
    const agent = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });

    try {
      for (let i = 0; i < 3; i++) {
        const { response, body } = await send(proxy.url, { agent });
        expect(body).toBe("close");
        expect(response.headers.connection).toBe("keep-alive");
      }
    } finally {
      agent.destroy();
    }
    expect(proxyConnections.value).toBe(1);
    expect(workerConnections.value).toBe(3);
  });

  it("cancels the Worker request when the client hangs up", async () => {
    let workerRequest: NodeHttp.IncomingMessage | undefined;
    const worker = await listen((req) => {
      // Never answers, like a long poll.
      workerRequest = req;
    });
    const proxy = await proxyTo(worker.url);

    const client = NodeHttp.request(proxy.url, { agent: false });
    client.on("error", () => {});
    client.end();
    await vi.waitFor(() => expect(workerRequest).toBeDefined());
    client.destroy();

    await vi.waitFor(() => expect(workerRequest!.socket.destroyed).toBe(true), { timeout: 1_000 });
    expect(proxy.logger.error).not.toHaveBeenCalled();
  });

  it("drops a request whose client hung up before it was forwarded", async () => {
    const worker = await listen((_req, res) => res.end("worker"));
    const workerConnections = countConnections(worker.server);
    const arrived = Promise.withResolvers<NodeHttp.IncomingMessage>();
    const forward = Promise.withResolvers<void>();
    const proxy = await proxyTo(worker.url, (req) => {
      arrived.resolve(req);
      return forward.promise;
    });

    const client = NodeHttp.request(proxy.url, { agent: false });
    client.on("error", () => {});
    client.end();
    const proxied = await arrived.promise;
    client.destroy();
    await vi.waitFor(() => expect(proxied.socket.destroyed).toBe(true));
    forward.resolve();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workerConnections.value).toBe(0);
    expect(proxy.logger.error).not.toHaveBeenCalled();
  });

  it("ends the client's response when the Worker's is cut short", async () => {
    const worker = await listen((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n", () => req.socket.destroy());
    });
    const proxy = await proxyTo(worker.url);

    // Truncated: neither completed with a 502 page nor left open.
    await expect(send(proxy.url)).rejects.toThrow();
    expect(proxy.logger.error).toHaveBeenCalledTimes(1);
  });

  it("answers 502 when the Worker cannot be reached", async () => {
    const worker = await listen(() => {});
    worker.server.close();
    const proxy = await proxyTo(worker.url);

    const { response, body } = await send(proxy.url);

    expect(response.statusCode).toBe(502);
    expect(body).toBe("Bad Gateway");
    expect(proxy.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Worker request failed"),
      expect.anything(),
    );
  });
});
