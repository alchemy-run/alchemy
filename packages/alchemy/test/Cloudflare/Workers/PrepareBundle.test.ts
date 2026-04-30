import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { destroy, test } from "@/Test/Vitest";
import { sha256 } from "@/Util/sha256";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Path to a hand-written ESM bundle that must be uploaded as-is.
// Re-bundling would strip the SENTINEL comment and likely rename
// `kSentinel`, both of which we assert against below.
const main = pathe.resolve(import.meta.dirname, "preBundledWorker.mjs");

test(
  "bundle: false uploads main byte-for-byte (no rolldown step)",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { accountId } = yield* CloudflareEnvironment;

    yield* destroy();

    // Compute the expected bundle hash directly from the source bytes
    // using the same hash function alchemy uses internally.
    const sourceBytes = yield* fs.readFile(main);
    const expectedBundleHash = yield* sha256(sourceBytes);

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("BundleFalseWorker", {
          main,
          bundle: false,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    // The bundle hash equals the SHA-256 of the source bytes only when
    // alchemy skipped the rolldown step. Any rebundling would minify
    // the file and produce a different hash.
    expect(worker.hash?.bundle).toEqual(expectedBundleHash);

    // End-to-end check: hit the worker URL and confirm the literal
    // sentinel string survived the upload. Rolldown's minifier would
    // typically rename the local `kSentinel` const but preserve the
    // string literal, so the body check is mostly a smoke test;
    // the hash assertion above is the primary guarantee.
    if (worker.url) {
      const response = yield* Effect.tryPromise(() => fetch(worker.url!));
      const body = yield* Effect.tryPromise(() => response.text());
      expect(body).toEqual("alchemy-bundle-false-test/7f1c");
      expect(response.headers.get("x-alchemy-sentinel")).toEqual(
        "alchemy-bundle-false-test/7f1c",
      );
    }

    // Re-deploy with no changes: hash must remain stable.
    const reDeployed = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("BundleFalseWorker", {
          main,
          bundle: false,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );
    expect(reDeployed.hash?.bundle).toEqual(expectedBundleHash);

    yield* destroy();
    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

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
