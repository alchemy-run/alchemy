import { describe } from "bun:test";
import path from "node:path";
import { alchemy } from "../../src/alchemy.js";
import { bootstrapPlugin } from "../../src/bootstrap/plugin.js";
import { bundleWorkerScript } from "../../src/cloudflare/bundle/bundle-worker.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("bootstrap", () => {
  test("bundleWorkerScript should replace Resources", async () => {
    const bundle = await bundleWorkerScript({
      compatibilityDate: "2025-05-09",
      compatibilityFlags: ["nodejs_compat"],
      format: "esm",
      entrypoint: path.join(import.meta.dir, "app.ts"),
      bundle: {
        bundle: true,
        plugins: [bootstrapPlugin],
        platform: "node",
        external: ["libsodium*", "@swc/*", "esbuild", "undici", "ws"],
        metafile: true,
        outfile: path.join(import.meta.dir, "app.js"),
        treeShaking: true,
      },
    });
    console.log("Bundle Size (KB)", bundle.length / 1024);
  });
});
