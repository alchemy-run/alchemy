import * as fs from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vite from "vite";
import { expect, onTestFinished, test, vi } from "vitest";
import cloudflareVitePlugin from "../plugin.ts";

// Starts a dev server for a Worker whose module source is `source`.
const devServer = async (source: string): Promise<string> => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  // Only the local runtime is used; no Cloudflare API calls are made.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-proxy-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.js");
  await fs.writeFile(entry, source);
  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      cloudflareVitePlugin({ main: entry, worker: { name: "vite-dev-proxy-test", bindings: [] } }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  return server.resolvedUrls!.local[0]!;
};

// Sends a request with `node:http`, which, unlike `fetch`, can pin requests to
// one kept-alive connection.
const send = (
  url: URL,
  options: { agent: NodeHttp.Agent | false; method?: string; body?: Buffer },
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.request(url.href, {
      agent: options.agent,
      method: options.method ?? "GET",
      signal: AbortSignal.timeout(10_000),
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
      );
    });
    request.end(options.body);
  });

test("stops the Worker's stream when the client hangs up", async () => {
  // An endless event stream, like a page's SSE subscription, counting the
  // chunks it is asked for.
  const url = await devServer(`
    const encoder = new TextEncoder();
    let pulls = 0;
    export default {
      fetch(request) {
        if (new URL(request.url).pathname === "/pulls") {
          return Response.json({ pulls });
        }
        return new Response(
          new ReadableStream({
            async pull(controller) {
              pulls++;
              await new Promise((resolve) => setTimeout(resolve, 50));
              controller.enqueue(encoder.encode("data: tick\\n\\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    };
  `);
  const pulls = async () => {
    const response = await fetch(new URL("/pulls", url), { signal: AbortSignal.timeout(5_000) });
    return ((await response.json()) as { pulls: number }).pulls;
  };

  const client = new AbortController();
  const stream = await fetch(new URL("/events", url), { signal: client.signal });
  await stream.body!.getReader().read();
  client.abort();

  // workerd stops pulling once it sees the request cancelled.
  await sleep(500);
  const afterHangUp = await pulls();
  await sleep(500);
  expect(await pulls()).toBe(afterHangUp);
});

test("keeps connections usable after the Worker answers without reading the body", async () => {
  // A body size cap, checked before the body is read.
  const url = await devServer(`
    export default {
      fetch(request) {
        if (Number(request.headers.get("content-length")) > 1024 * 1024) {
          return new Response("too large", { status: 413 });
        }
        return new Response("ok");
      },
    };
  `);
  const keptAlive = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
  onTestFinished(() => keptAlive.destroy());

  const tooLarge = await send(new URL("/upload", url), {
    agent: keptAlive,
    method: "POST",
    body: Buffer.alloc(1024 * 1024 + 1, "a"),
  });
  expect(tooLarge).toEqual({ status: 413, body: "too large" });
  // A forwarded request doesn't get the connection workerd closed after the
  // upload.
  expect(await send(new URL("/", url), { agent: false })).toEqual({ status: 200, body: "ok" });
  // The client's connection, which carried the upload, is still usable.
  expect(await send(new URL("/", url), { agent: keptAlive })).toEqual({ status: 200, body: "ok" });
});

test("streams the Worker's response while the request body is still arriving", async () => {
  // Echoes the request body: the response starts before the body has been
  // read.
  const url = await devServer(`
    export default {
      fetch(request) {
        return new Response(request.body);
      },
    };
  `);
  const body = Buffer.alloc(4 * 1024 * 1024, "a");

  const echo = await send(new URL("/echo", url), { agent: false, method: "POST", body });
  expect(echo.status).toBe(200);
  expect(echo.body.length).toBe(body.length);
});
