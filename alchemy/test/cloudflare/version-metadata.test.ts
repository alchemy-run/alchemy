import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { VersionMetadata } from "../../src/cloudflare/version-metadata.js";
import { Worker } from "../../src/cloudflare/worker.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

import path from "node:path";
import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("VersionMetadata Binding", () => {
  test("create worker with version metadata binding", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-version-metadata-worker`;

    let worker: Worker | undefined;

    try {
      worker = await Worker(workerName, {
        name: workerName,
        entrypoint: path.join(
          import.meta.dirname,
          "version-metadata-handler.ts",
        ),
        format: "esm",
        url: true,
        bindings: {
          VERSION_METADATA: new VersionMetadata(),
        },
      });

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeDefined();
      expect(worker.url).toBeTruthy();

      const response = await fetch(worker.url!);
      expect(response.status).toEqual(200);
      const text = await response.text();
      expect(text).toContain("VersionMetadata binding available");
    } finally {
      await destroy(scope);
    }
  });
});
