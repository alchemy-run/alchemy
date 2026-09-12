import cloudflareVitePlugin from "../plugin.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vite from "vite";
import { afterEach, describe, expect, test } from "vitest";

/**
 * Regression harness for a Vite project whose config file re-roots the
 * project into a SUBDIRECTORY (`root: "ui"`) — the shape a fullstack
 * app uses when the SPA lives beside the server code (e.g.
 * alchemy-org). The worker `main` is given root-relative, exactly as
 * `Cloudflare.Website.Vite` forwards it.
 */
const WORKER = `
export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

/** Under `.cache` so a crashed run cannot leave untracked files behind. */
const TMP_ROOT = path.resolve(import.meta.dirname, "../.cache/test-roots");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function makeProject() {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  const project = await fs.mkdtemp(path.join(TMP_ROOT, "root-subdir-"));
  cleanups.push(() => fs.rm(project, { recursive: true, force: true }));

  await fs.mkdir(path.join(project, "ui"), { recursive: true });
  await fs.writeFile(path.join(project, "ui", "edge.ts"), WORKER);
  await fs.writeFile(
    path.join(project, "ui", "index.html"),
    "<!doctype html><html><body>spa</body></html>",
  );
  return project;
}

async function startDevServer(options: {
  root: string;
  main: string;
  assets?: { directory: string; runWorkerFirst?: Array<string> };
}) {
  const server = await vite.createServer({
    root: options.root,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: options.main,
        compatibilityDate: "2026-03-10",
        worker: {
          name: "vite-plugin-root-subdir-test",
          bindings: [],
          ...(options.assets === undefined
            ? {}
            : {
                assets: {
                  ...options.assets,
                  notFoundHandling: "single-page-application" as const,
                },
              }),
        },
      }),
    ],
  });
  cleanups.push(() => server.close());
  await server.listen();

  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("Dev server did not report a local URL");
  }

  const get = async (pathname = "/") => {
    try {
      const response = await fetch(new URL(pathname, url), {
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: 0, body: String(error) };
    }
  };

  return { get };
}

describe("dev with the vite root in a subdirectory", () => {
  test("root = the subdirectory: assets serve the SPA, other paths hit the worker", async () => {
    const project = await makeProject();
    const { get } = await startDevServer({
      root: path.join(project, "ui"),
      main: "edge.ts",
    });
    // `/` is the SPA's index.html (vite's own middleware) …
    const index = await get("/");
    expect(index.status).toBe(200);
    expect(index.body).toContain("spa");
    // … and a non-asset path falls through to the worker proxy
    expect(await get("/api/ping")).toEqual({ status: 200, body: "ok" });
  });

  test("root = the project dir, subdir-relative main serves the worker", async () => {
    const project = await makeProject();
    const { get } = await startDevServer({ root: project, main: "ui/edge.ts" });
    expect(await get("/api/ping")).toEqual({ status: 200, body: "ok" });
  });

  test("a runWorkerFirst LIST does not swallow the module runner's init channel", async () => {
    const project = await makeProject();
    // the regression this pins: with SPA-fallback assets and
    // `runWorkerFirst` in its LIST form, every unlisted path — the
    // module runner's `INIT_PATH` WebSocket included — was routed
    // assets-first and answered with 200 index.html ("Expected 101
    // status code"), so the dev server never became ready. The init
    // path must be forced worker-first alongside the user's list.
    const { get } = await startDevServer({
      root: path.join(project, "ui"),
      main: "edge.ts",
      assets: {
        directory: path.join(project, "ui"),
        runWorkerFirst: ["/api/*"],
      },
    });
    expect(await get("/api/ping")).toEqual({ status: 200, body: "ok" });
  });

  test("a main that does not exist fails FAST with the resolved path", async () => {
    const project = await makeProject();
    // the trap this pins: an inline root overrides a config file's
    // `root: "ui"`, so a root-relative `main` written for the config
    // file's root resolves against the wrong directory — the plugin
    // must name the path at CONFIG time, not NUL-garble it at request
    // time inside the module runner
    await expect(
      startDevServer({ root: project, main: "edge.ts" }),
    ).rejects.toThrow(/worker entry 'edge' resolves to '.*edge\.ts'/);
  });
});
