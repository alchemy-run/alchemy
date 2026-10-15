import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { runR2Checks } from "./r2-checks.ts";
import { CpuCopyBucket, copyR2, r2Sizes, seedR2, verifyR2, type R2Size } from "./r2-workloads.ts";

const headers = { "cache-control": "no-store" };

export default Cloudflare.Worker(
  "R2CopyWorker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-09-01" },
    workersDev: true,
    cache: { enabled: false },
    build: { output: { sourcemap: "hidden" } },
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
      traces: { enabled: false },
    },
  },
  Effect.gen(function* () {
    const bucket = yield* CpuCopyBucket;
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    const version = yield* Cloudflare.Workers.VersionMetadata();
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://r2-copy.invalid");
        if (url.pathname === "/health" && request.method === "GET") {
          return yield* HttpServerResponse.json(
            {
              ok: true,
              harness: "cloudflare-cpu-r2-v1",
              version: yield* version,
              diagnostic: "Real R2 get + put; effect-body copy and native-readable control",
            },
            { headers },
          );
        }
        if (url.pathname === "/r2-checks" && request.method === "GET") {
          const result = yield* runR2Checks(r2);
          return yield* HttpServerResponse.json(
            { ...result, version: yield* version },
            { headers },
          );
        }
        const route = url.pathname;
        const allowed = [
          "/r2-seed",
          "/r2-verify-seed",
          "/r2-copy-effect",
          "/r2-copy-native",
          "/r2-verify-effect",
          "/r2-verify-native",
        ];
        if (!allowed.includes(route))
          return HttpServerResponse.text("Not found", { status: 404, headers });
        if (request.method !== (route === "/r2-seed" ? "POST" : "GET")) {
          return HttpServerResponse.text("Method not allowed", { status: 405, headers });
        }
        const raw = url.searchParams.get("count") ?? "16";
        const count = Number(raw);
        if (!/^(1|16|64)$/.test(raw) || !r2Sizes.includes(count as R2Size)) {
          return HttpServerResponse.text("count must be 1, 16 or 64 MiB", { status: 400, headers });
        }
        const mib = count as R2Size;
        const result =
          route === "/r2-seed"
            ? yield* seedR2(r2, mib)
            : route === "/r2-verify-seed"
              ? yield* verifyR2(r2, mib, "seed")
              : route === "/r2-copy-effect"
                ? yield* copyR2(r2, mib, "effect")
                : route === "/r2-copy-native"
                  ? yield* copyR2(r2, mib, "native")
                  : yield* verifyR2(r2, mib, route === "/r2-verify-effect" ? "effect" : "native");
        return yield* HttpServerResponse.json({ ...result, version: yield* version }, { headers });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Workers.VersionMetadataBinding,
      ),
    ),
  ),
);
