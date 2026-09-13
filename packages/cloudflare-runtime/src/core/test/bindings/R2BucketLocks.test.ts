import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as R2Bucket from "../../bindings/r2-bucket/R2Bucket.ts";
import { type R2BucketLockRule } from "../../bindings/r2-bucket/R2BucketOptions.shared.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const rules: R2BucketLockRule[] = [
  { id: "retention", prefix: "audit/", condition: { type: "Indefinite" } },
];

layer(localRuntimeLayer)("R2 bucket locks binding", (it) => {
  it.effect(
    "enforces age, absolute expiry, disabled rules and longest retention in workerd",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "r2-retention-conditions",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            R2Bucket.local({
              binding: "AGE",
              id: "age",
              lockRules: [
                { id: "age", condition: { type: "Age", maxAgeSeconds: 1 } },
              ],
            }),
            R2Bucket.local({
              binding: "PAST",
              id: "past",
              lockRules: [
                {
                  id: "date",
                  condition: { type: "Date", date: "2020-01-01T00:00:00Z" },
                },
              ],
            }),
            R2Bucket.local({
              binding: "FUTURE",
              id: "future",
              lockRules: [
                { id: "age", condition: { type: "Age", maxAgeSeconds: 0 } },
                {
                  id: "date",
                  condition: { type: "Date", date: "2099-01-01T00:00:00Z" },
                },
              ],
            }),
            R2Bucket.local({
              binding: "DISABLED",
              id: "disabled",
              lockRules: [
                {
                  id: "disabled",
                  enabled: false,
                  condition: { type: "Indefinite" },
                },
              ],
            }),
          ],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: `export default { async fetch(request, env) {
        if (new URL(request.url).pathname === "/expire") { await env.AGE.delete("key"); return Response.json(await env.AGE.get("key")); }
        const result = {};
        for (const name of ["AGE", "PAST", "FUTURE", "DISABLED"]) { await env[name].put("key", "data"); try { await env[name].delete("key"); result[name] = "deleted"; } catch { result[name] = "locked"; } }
        return Response.json(result);
      }};`,
            },
          ],
        });
        expect(yield* worker.fetchJson("/")).toEqual({
          AGE: "locked",
          PAST: "deleted",
          FUTURE: "locked",
          DISABLED: "deleted",
        });
        yield* Effect.promise(
          () => new Promise((resolve) => setTimeout(resolve, 1100)),
        );
        expect(yield* worker.fetchJson("/expire")).toBeNull();
      }),
  );

  it.effect(
    "rejects overwrite, batch delete and multipart overwrite while allowing new keys",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "r2-bucket-locks",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            R2Bucket.local({
              binding: "BUCKET",
              id: "locked",
              lockRules: rules,
            }),
          ],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: `export default { async fetch(request, env) {
        const result = {};
        await env.BUCKET.put("audit/log", "original");
        await env.BUCKET.put("public/log", "original");
        for (const [operation, fn] of Object.entries({
          put: () => env.BUCKET.put("audit/log", "changed"),
          delete: () => env.BUCKET.delete("audit/log"),
          batch: () => env.BUCKET.delete(["public/log", "audit/log"]),
          multipart: async () => {
            const upload = await env.BUCKET.createMultipartUpload("audit/log");
            const part = await upload.uploadPart(1, "changed");
            try { await upload.complete([part]); } finally { await upload.abort(); }
          },
        })) {
          try { await fn(); result[operation] = false; } catch { result[operation] = true; }
        }
        result.original = await (await env.BUCKET.get("audit/log")).text();
        result.public = await (await env.BUCKET.get("public/log")).text();
        await env.BUCKET.put("public/log", "changed");
        await env.BUCKET.delete("public/log");
        await env.BUCKET.delete("missing");
        result.deleted = (await env.BUCKET.get("public/log")) === null;
        return Response.json(result);
      }};`,
            },
          ],
        });
        expect(yield* worker.fetchJson("/")).toEqual({
          put: true,
          delete: true,
          batch: true,
          multipart: true,
          original: "original",
          public: "original",
          deleted: true,
        });
      }),
  );
});
