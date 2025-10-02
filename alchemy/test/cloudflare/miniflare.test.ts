import "../../src/test/vitest.ts";

import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { R2Bucket } from "../../src/cloudflare/bucket.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
  local: true,
});

describe("Miniflare", () => {
  test("remote R2 bucket", async (scope) => {
    try {
      const api = await createCloudflareApi();
      const bucket = await R2Bucket("bucket", {
        dev: { remote: true },
        empty: true,
      });
      const worker = await Worker("worker", {
        script: `
        export default {
          async fetch(request, env, ctx) {
            const file = await env.R2.get("test-object-key");
            if (!file) {
            return Response.json({ error: "File not found" }, { status: 404 });
            }
            const headers = new Headers();
            file.writeHttpMetadata(headers);
            return new Response(file.body, { headers });
          }
        }
      `,
        bindings: {
          R2: bucket,
        },
      });

      expect(worker.url).toBeDefined();
      expect(worker.url).toMatch(/^http:\/\/localhost:\d+/);

      const res1 = await fetch(worker.url!);
      expect(res1.status).toEqual(404);

      await api.fetch(
        `/accounts/${api.accountId}/r2/buckets/${bucket.name}/objects/test-object-key`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "text/plain",
          },
          body: "test-object-value",
        },
      );
      const res2 = await fetch(worker.url!);
      expect(res2.status).toEqual(200);
      expect(res2.headers.get("Content-Type")).toEqual("text/plain");
      expect(await res2.text()).toEqual("test-object-value");
    } finally {
      await destroy(scope);
    }
  });
});
