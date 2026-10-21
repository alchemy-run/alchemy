import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vite from "vite";
import { expect, onTestFinished, test, vi } from "vitest";
import * as Assets from "../../core/bindings/assets/Assets.ts";
import cloudflareVitePlugin from "../plugin.ts";

test.each([
  ["selective Worker routes", ["/api/*"]],
  ["explicitly excluded internal routes", ["/api/*", "!/cdn-cgi/alchemy/module-runner/*"]],
  ["assets first", false],
  ["Worker first", true],
] as const)("starts the module runner with SPA fallback and %s", async (_, runWorkerFirst) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  // These tests use only the local runtime; no Cloudflare API calls are needed.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.js");
  await fs.writeFile(path.join(root, "index.html"), "<html><body>SPA shell</body></html>");
  await fs.writeFile(
    entry,
    `
    export default {
      fetch(request, env) {
        if (new URL(request.url).pathname.startsWith("/api/")) {
          return new Response("api");
        }
        return env.ASSETS.fetch(request);
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
      cloudflareVitePlugin({
        main: entry,
        worker: {
          name: "vite-dev-assets-test",
          bindings: [Assets.local("ASSETS")],
          assets: {
            runWorkerFirst:
              typeof runWorkerFirst === "boolean" ? runWorkerFirst : [...runWorkerFirst],
            notFoundHandling: "single-page-application",
          },
        },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];
  const page = await fetch(new URL("/dashboard", url), {
    signal: AbortSignal.timeout(5_000),
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("SPA shell");
  if (runWorkerFirst !== false) {
    const api = await fetch(new URL("/api/hello", url), {
      signal: AbortSignal.timeout(5_000),
    });
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("api");
  }
});

test("a Worker reads HTML and binary files in Vite's publicDir through ASSETS", async () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "local-test-unused");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "00000000000000000000000000000000");
  const tmpRoot = path.resolve(import.meta.dirname, "../.cache/test-roots");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "dev-assets-public-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  await fs.mkdir(path.join(root, "public"));
  await fs.writeFile(
    path.join(root, "public", "about.html"),
    "<html><body>public page</body></html>",
  );
  await fs.writeFile(path.join(root, "public", "og.png"), png);
  const entry = path.join(root, "worker.js");
  await fs.writeFile(
    entry,
    `
    export default {
      fetch(request, env) {
        const { pathname } = new URL(request.url);
        return env.ASSETS.fetch(new URL(pathname.slice("/read".length), request.url));
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
      cloudflareVitePlugin({
        main: entry,
        worker: {
          name: "vite-dev-assets-public-test",
          bindings: [Assets.local("ASSETS")],
          assets: { runWorkerFirst: ["/read/*"] },
        },
      }),
    ],
  });
  onTestFinished(() => server.close());
  await server.listen();
  const url = server.resolvedUrls!.local[0];

  const page = await fetch(new URL("/read/about", url), { signal: AbortSignal.timeout(5_000) });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toBe("<html><body>public page</body></html>");

  const image = await fetch(new URL("/read/og.png", url), { signal: AbortSignal.timeout(5_000) });
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
});
