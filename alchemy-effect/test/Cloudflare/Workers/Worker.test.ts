import * as Cloudflare from "@/Cloudflare";
import { Account } from "@/Cloudflare/Account";
import * as R2 from "@/Cloudflare/R2";
import * as Worker from "@/Cloudflare/Workers";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
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
    const accountId = yield* Account;

    yield* destroy();

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        yield* R2.Bucket("Bucket", {
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

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);

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

    const actualUpdatedWorker = yield* findWorker(
      updatedWorker.workerName,
      accountId,
    );
    expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
    const actualUpdatedSubdomain = yield* workers.getScriptSubdomain({
      accountId,
      scriptName: updatedWorker.workerName,
    });
    expect(actualUpdatedSubdomain).toEqual({
      enabled: true,
      previewsEnabled: true,
    });

    yield* destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete worker with assets",
  Effect.gen(function* () {
    const accountId = yield* Account;

    yield* destroy();

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Worker.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);

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
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualUpdatedWorker = yield* findWorker(
      updatedWorker.workerName,
      accountId,
    );
    expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
    expect(updatedWorker.hash?.assets).toBeDefined();

    // Final update
    const finalWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Worker.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previews_enabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    yield* destroy();

    yield* waitForWorkerToBeDeleted(finalWorker.workerName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

const findWorker = Effect.fn(function* (workerName: string, accountId: string) {
  const matches = yield* workers.searchScript({
    accountId,
    name: workerName,
  });
  return matches.find((worker) => worker.scriptName === workerName);
});

const waitForWorkerToBeDeleted = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  yield* workers
    .getScript({
      accountId,
      scriptName: workerName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new WorkerStillExists())),
      Effect.retry({
        while: (e): e is WorkerStillExists => e instanceof WorkerStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("WorkerNotFound", () => Effect.void),
    );
});

class WorkerStillExists extends Data.TaggedError("WorkerStillExists") {}
