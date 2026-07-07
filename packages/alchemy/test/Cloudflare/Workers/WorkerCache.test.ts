import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectUrlContains } from "../Utils/Http.ts";
import CacheTestWorker from "./fixtures/cache/cache-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The worker stamps every invocation with a fresh UUID, so two fetches of
// the same URL returning the same body means the second response was served
// from the Workers Cache without invoking the worker.
const cachedScript = `export default {
  async fetch() {
    return new Response("id:" + crypto.randomUUID(), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  },
};
`;

const fetchCached = (url: string) =>
  Effect.tryPromise(async (signal) => {
    // NO cache-busting here — the whole point is hitting the same cache key.
    const res = await fetch(url, { signal });
    return {
      status: res.status,
      cacheStatus: res.headers.get("cf-cache-status"),
      body: await res.text(),
    };
  });

test.provider(
  "worker with Workers Cache enabled serves repeat requests from cache",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("CachedWorker", {
              script: cachedScript,
              cache: {
                enabled: true,
                crossVersionCache: true,
              },
            }),
          };
        }),
      );
      expect(worker.url).toBeDefined();

      // Ride out workers.dev propagation before probing cache behavior.
      yield* expectUrlContains(worker.url!, "id:", {
        label: "cached worker propagation",
      });

      // Repeatedly fetch the same URL until two consecutive responses carry
      // the same invocation id (i.e. the second was a cache hit). Bounded so
      // a broken cache fails fast instead of running into the vitest timeout.
      const url = `${worker.url}/cached`;
      let previous: string | undefined;
      const hit = yield* fetchCached(url).pipe(
        Effect.map((res) => {
          const isHit =
            (res.status === 200 &&
              previous !== undefined &&
              res.body === previous) ||
            res.cacheStatus === "HIT";
          previous = res.body;
          return { ...res, isHit };
        }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res) => res.isHit,
          times: 20,
        }),
      );
      expect(hit.isHit).toBe(true);

      // Metadata-only update: same script, cache turned off. The metadata
      // hash must register the change and the API must accept the update.
      const disabled = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("CachedWorker", {
              script: cachedScript,
              cache: {
                enabled: false,
              },
            }),
          };
        }),
      );
      expect(disabled.worker.workerName).toEqual(worker.workerName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// Effect-native path: `yield* Cloudflare.cache()` in the init phase enables
// Workers Cache via the binding contract (no `cache` prop) and returns the
// runtime purge client backed by `ctx.cache`.
test.provider(
  "Cloudflare.cache() enables the cache and purges by tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* CacheTestWorker };
        }),
      );
      expect(worker.url).toBeDefined();

      yield* expectUrlContains(`${worker.url}/item`, "id:", {
        label: "cache worker propagation",
      });

      // Poll the same URL until a repeat body proves the binding actually
      // enabled the cache.
      const url = `${worker.url}/item`;
      let previous: string | undefined;
      const hit = yield* fetchCached(url).pipe(
        Effect.map((res) => {
          const isHit =
            res.status === 200 &&
            previous !== undefined &&
            res.body === previous;
          previous = res.body;
          return { ...res, isHit };
        }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res) => res.isHit,
          times: 20,
        }),
      );
      expect(hit.isHit).toBe(true);
      const cachedBody = hit.body;

      // Purge by Cache-Tag through the runtime client.
      const purged = yield* fetchCached(`${worker.url}/purge`);
      expect(purged.status).toBe(200);
      expect((JSON.parse(purged.body) as { success: boolean }).success).toBe(
        true,
      );

      // A fresh invocation id proves the tag purge evicted the entry.
      const fresh = yield* fetchCached(url).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res) => res.status === 200 && res.body !== cachedBody,
          times: 20,
        }),
      );
      expect(fresh.body).not.toBe(cachedBody);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
