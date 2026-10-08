import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vite from "vite";
import { expect, onTestFinished, test, vi } from "vitest";
import cloudflareVitePlugin from "../plugin.ts";

test("stops the Worker's stream when the client hangs up", async () => {
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
  // An endless event stream, like a page's SSE subscription, counting the
  // chunks it is asked for.
  await fs.writeFile(
    entry,
    `
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
  `,
  );
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
  const url = server.resolvedUrls!.local[0];
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
