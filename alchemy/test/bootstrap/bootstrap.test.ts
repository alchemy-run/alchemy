import { describe } from "bun:test";
import path from "node:path";
import { alchemy } from "../../src/alchemy.js";
import { bootstrapPlugin } from "../../src/bootstrap/plugin.js";
import { bundleWorkerScript } from "../../src/cloudflare/bundle/bundle-worker.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

describe("bootstrap", () => {
  test("should replace Resources", async () => {
    const bundle = await bundleWorkerScript({
      compatibilityDate: "2025-05-09",
      compatibilityFlags: [],
      format: "esm",
      entrypoint: path.join(import.meta.dir, "app.ts"),
      bundle: {
        plugins: [bootstrapPlugin],
        platform: "node",
        external: ["libsodium*"],
        metafile: true,
        outdir: import.meta.dir,
        treeShaking: true,
      },
    });
    console.log("Bundle Size (KB)", bundle.length / 1024);
  });
});
