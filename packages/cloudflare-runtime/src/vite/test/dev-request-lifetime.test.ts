import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vite from "vite";
import { afterEach, describe, expect, test } from "vitest";
import cloudflareVitePlugin from "../plugin.ts";

/**
 * A Worker that caches its first dynamic import for every later request, the
 * way TanStack Start caches its router and start entries. `/early` starts the
 * import but answers before it settles, as a request does when its client
 * hangs up and the handler responds to the abort.
 */
const worker = `
let loading;
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/warm") {
      return new Response("warm");
    }
    loading ??= import("./slow.js");
    if (pathname === "/early") {
      return new Response("early");
    }
    const { value } = await loading;
    return new Response(value);
  },
};
`;

const slow = `
await new Promise((resolve) => setTimeout(resolve, 1_000));
export const value = "loaded";
`;

/** Under `.cache` so a crashed run cannot leave untracked files behind. */
const TMP_ROOT = path.resolve(import.meta.dirname, "../.cache/test-roots");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startDevServer() {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(TMP_ROOT, "request-lifetime-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

  const entry = path.join(root, "worker.js");
  await fs.writeFile(entry, worker);
  await fs.writeFile(path.join(root, "slow.js"), slow);

  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        compatibilityDate: "2026-03-10",
        worker: { name: "vite-plugin-request-lifetime-test", bindings: [] },
      }),
    ],
  });
  cleanups.push(() => server.close());
  await server.listen();

  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("Dev server did not report a local URL");
  }
  const get = async (pathname: string) => {
    const response = await fetch(new URL(pathname, url), { signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.text() };
  };
  return get;
}

describe("module runner request lifetime", () => {
  test("an import outlives the request that started it", async () => {
    const get = await startDevServer();
    // Evaluate the entry first, so `/early` is the request that starts the import.
    expect(await get("/warm")).toEqual({ status: 200, body: "warm" });

    expect(await get("/early")).toEqual({ status: 200, body: "early" });

    expect(await get("/")).toEqual({ status: 200, body: "loaded" });
  }, 30_000);
});
