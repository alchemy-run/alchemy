import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as R2 from "@/Cloudflare/R2";
import { Stack } from "@/Stack";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import {
  findWorker,
  getWorkerTags,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";
import InternalWorker from "./internal-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "worker.ts");

test.provider("create, update, delete worker", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const s = yield* Stack;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        yield* R2.R2Bucket("Bucket", {
          storageClass: "Standard",
        });

        const worker = yield* Cloudflare.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });

        return worker;
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${s.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${s.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:TestWorker",
    );

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previewsEnabled: true },
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

    yield* stack.destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete worker with assets", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const s = yield* Stack;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${s.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${s.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:TestWorkerWithAssets",
    );

    // Verify the worker has assets
    expect(worker.hash?.assets).toBeDefined();

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker with Assets URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
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
    const finalWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          url: true,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    yield* stack.destroy();

    yield* waitForWorkerToBeDeleted(finalWorker.workerName, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete internal worker", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const s = yield* Stack;

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* InternalWorker;
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${s.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${s.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:InternalWorker",
    );

    const updatedWorker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* InternalWorker;
      }),
    );

    expect(updatedWorker.workerName).toEqual(worker.workerName);

    yield* stack.destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(logLevel),
);
