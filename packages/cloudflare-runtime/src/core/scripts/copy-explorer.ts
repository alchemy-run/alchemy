/**
 * Copies Miniflare's prebuilt Local Explorer (API worker, UI assets and the
 * Durable Object introspection wrapper) into `dist/core/explorer`, where the
 * runtime resolves them via the `#cloudflare-runtime-explorer/*` import.
 *
 * Miniflare is a dev dependency only: depending on it at runtime would pull
 * in a second `workerd` binary pinned to Miniflare's own version.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `miniflare` resolves to `<root>/dist/src/index.js`.
const miniflareRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("miniflare"))),
  "../..",
);
const target = path.resolve(import.meta.dirname, "../../../dist/core/explorer");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all([
  cp(
    path.join(
      miniflareRoot,
      "dist/src/workers/local-explorer/explorer.worker.js",
    ),
    path.join(target, "explorer.worker.js"),
  ),
  cp(
    path.join(miniflareRoot, "dist/src/workers/core/do-wrapper.worker.js"),
    path.join(target, "do-wrapper.worker.js"),
  ),
  cp(
    path.join(miniflareRoot, "dist/local-explorer-ui"),
    path.join(target, "ui"),
    { recursive: true },
  ),
]);
