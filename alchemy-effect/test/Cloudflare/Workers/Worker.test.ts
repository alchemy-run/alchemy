import * as Cloudflare from "@/Cloudflare";
import { Account } from "@/Cloudflare/Account";
import { CloudflareApi } from "@/Cloudflare/CloudflareApi";
import * as R2 from "@/Cloudflare/R2";
import * as Worker from "@/Cloudflare/Workers";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "worker.ts");

test(
  "create, update, delete worker",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* Account;

    yield* destroy();

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        const bucket = yield* R2.Bucket("Bucket", {
          name: "test-bucket-worker",
          storageClass: "Standard",
        });

        return yield* Worker.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualWorker = yield* api.workers.beta.workers.get(
      worker.workerName,
      {
        account_id: accountId,
      },
    );
    expect(actualWorker.name).toEqual(worker.workerName);

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Worker.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualUpdatedWorker = yield* api.workers.beta.workers.get(
      updatedWorker.workerName,
      {
        account_id: accountId,
      },
    );
    expect(actualUpdatedWorker.name).toEqual(updatedWorker.workerName);
    expect(actualUpdatedWorker.subdomain).toEqual({
      enabled: true,
      previews_enabled: true,
    });

    yield* destroy();

    yield* waitForWorkerToBeDeleted(worker.workerId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete worker with assets",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* Account;

    yield* destroy();

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Worker.Worker("TestWorkerWithAssets", {
          main,
          name: "test-worker-with-assets",
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualWorker = yield* api.workers.beta.workers.get(
      worker.workerName,
      {
        account_id: accountId,
      },
    );
    expect(actualWorker.name).toEqual(worker.workerName);

    // Verify the worker has assets
    expect(worker.hash?.assets).toBeDefined();

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker with Assets URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Worker.Worker("TestWorkerWithAssets", {
          main,
          name: "test-worker-with-assets",
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualUpdatedWorker = yield* api.workers.beta.workers.get(
      updatedWorker.workerName,
      {
        account_id: accountId,
      },
    );
    expect(actualUpdatedWorker.name).toEqual(updatedWorker.workerName);
    expect(updatedWorker.hash?.assets).toBeDefined();

    // Final update
    const finalWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Worker.Worker("TestWorkerWithAssets", {
          main,
          name: "test-worker-with-assets",
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    yield* destroy();

    yield* waitForWorkerToBeDeleted(finalWorker.workerId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
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
