import { CloudflareAccountId, CloudflareApi } from "@/cloudflare/api";
import * as CloudflareLive from "@/cloudflare/live";
import * as R2 from "@/cloudflare/r2";
import * as Worker from "@/cloudflare/worker";
import * as Assets from "@/cloudflare/worker/assets.fetch";
import { $, apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const logLevel = Logger.withMinimumLogLevel(
  process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
);

// TODO(sam): it's a hack to have this here - it means the `fetch` functioin of Worker.serve will never be called
// we're gonna need closure serializer LMAO
const main = pathe.resolve(import.meta.dirname, "worker.ts");

test(
  "create, update, delete worker",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* CloudflareAccountId;

    {
      class Bucket extends R2.Bucket("Bucket", {
        name: "test-bucket-initial",
        storageClass: "Standard",
      }) {}

      class TestWorker extends Worker.serve("TestWorker", {
        fetch: Effect.fn(function* (request) {
          yield* R2.get(Bucket, "test");
          return new Response("Hello from TestWorker v1");
        }),
      })({
        main,
        bindings: $(R2.Bind(Bucket)),
        subdomain: { enabled: true, previews_enabled: true },
        compatibility: {
          date: "2024-01-01",
        },
      }) {}

      const stack = yield* apply(TestWorker);

      const actualWorker = yield* api.workers.beta.workers.get(
        stack.TestWorker.name,
        {
          account_id: accountId,
        },
      );
      expect(actualWorker.name).toEqual(stack.TestWorker.name);

      // Verify the worker is accessible via URL
      if (stack.TestWorker.url) {
        yield* Effect.logInfo(`Worker URL: ${stack.TestWorker.url}`);
      }
    }

    class TestWorker extends Worker.serve("TestWorker", {
      fetch: Effect.fn(function* (request) {
        return new Response("Hello from TestWorker v2");
      }),
    })({
      main,
      bindings: $(),
      subdomain: { enabled: true, previews_enabled: true },
      compatibility: {
        date: "2024-01-01",
      },
    }) {}

    const stack = yield* apply(TestWorker);

    const actualWorker = yield* api.workers.beta.workers.get(
      stack.TestWorker.name,
      {
        account_id: accountId,
      },
    );
    expect(actualWorker.name).toEqual(stack.TestWorker.name);
    expect(actualWorker.subdomain).toEqual({
      enabled: true,
      previews_enabled: true,
    });

    yield* destroy();

    yield* waitForWorkerToBeDeleted(stack.TestWorker.id, accountId);
  }).pipe(Effect.provide(CloudflareLive.live()), logLevel),
);

test(
  "create, update, delete worker with assets",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* CloudflareAccountId;

    {
      class TestWorkerWithAssets extends Worker.serve("TestWorkerWithAssets", {
        fetch: Effect.fn(function* (request) {
          const url = new URL(request.url);
          if (url.pathname === "/api") {
            return new Response("Hello from API");
          }
          // Serve assets for everything else
          return yield* Assets.fetch(request);
        }),
      })({
        main,
        name: "test-worker-with-assets",
        bindings: $(),
        assets: pathe.resolve(import.meta.dirname, "assets"),
        subdomain: { enabled: true, previews_enabled: true },
        compatibility: {
          date: "2024-01-01",
        },
      }) {}

      const stack = yield* apply(TestWorkerWithAssets);

      const actualWorker = yield* api.workers.beta.workers.get(
        stack.TestWorkerWithAssets.name,
        {
          account_id: accountId,
        },
      );
      expect(actualWorker.name).toEqual(stack.TestWorkerWithAssets.name);

      // Verify the worker has assets
      expect(stack.TestWorkerWithAssets.hash.assets).toBeDefined();

      // Verify the worker is accessible via URL
      if (stack.TestWorkerWithAssets.url) {
        yield* Effect.logInfo(
          `Worker with Assets URL: ${stack.TestWorkerWithAssets.url}`,
        );
      }
    }

    {
      // Update assets by modifying the test
      class TestWorkerWithAssets extends Worker.serve("TestWorkerWithAssets", {
        fetch: Effect.fn(function* (request) {
          const url = new URL(request.url);
          if (url.pathname === "/api/v2") {
            return new Response("Hello from API v2");
          }
          // Serve assets for everything else
          return yield* Assets.fetch(request);
        }),
      })({
        main,
        name: "test-worker-with-assets",
        bindings: $(),
        assets: pathe.resolve(import.meta.dirname, "assets"),
        subdomain: { enabled: true, previews_enabled: true },
        compatibility: {
          date: "2024-01-01",
        },
      }) {}

      const stack = yield* apply(TestWorkerWithAssets);

      const actualWorker = yield* api.workers.beta.workers.get(
        stack.TestWorkerWithAssets.name,
        {
          account_id: accountId,
        },
      );
      expect(actualWorker.name).toEqual(stack.TestWorkerWithAssets.name);
      expect(stack.TestWorkerWithAssets.hash.assets).toBeDefined();
    }

    class TestWorkerWithAssets extends Worker.serve("TestWorkerWithAssets", {
      fetch: Effect.fn(function* (request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v2") {
          return new Response("Hello from API v2");
        }
        // Serve assets for everything else
        return yield* Assets.fetch(request);
      }),
    })({
      main,
      name: "test-worker-with-assets",
      bindings: $(),
      assets: pathe.resolve(import.meta.dirname, "assets"),
      subdomain: { enabled: true, previews_enabled: true },
      compatibility: {
        date: "2024-01-01",
      },
    }) {}

    const stack = yield* apply(TestWorkerWithAssets);

    yield* destroy();

    yield* waitForWorkerToBeDeleted(stack.TestWorkerWithAssets.id, accountId);
  }).pipe(Effect.provide(CloudflareLive.live()), logLevel),
);

const waitForWorkerToBeDeleted = Effect.fn(function* (
  workerId: string,
  accountId: string,
) {
  const api = yield* CloudflareApi;
  yield* api.workers.scripts
    .get(workerId, {
      account_id: accountId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new WorkerStillExists())),
      Effect.retry({
        while: (e): e is WorkerStillExists => e instanceof WorkerStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

class WorkerStillExists extends Data.TaggedError("WorkerStillExists") {}
