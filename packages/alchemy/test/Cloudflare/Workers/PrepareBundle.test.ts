import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Vitest";
import { sha256 } from "@/Util/sha256";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "bundle: false uploads main byte-for-byte (no rolldown step)",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { accountId } = yield* CloudflareEnvironment;
      // Path to a hand-written ESM bundle that must be uploaded as-is.
      // Re-bundling would strip the SENTINEL comment and likely rename
      // `kSentinel`, both of which we assert against below.
      const main = path.resolve(import.meta.dirname, "preBundledWorker.mjs");

      yield* stack.destroy();

      // Compute the expected bundle hash directly from the source bytes
      // using the same hash function alchemy uses internally.
      const sourceBytes = yield* fs.readFile(main);
      const expectedBundleHash = yield* sha256(sourceBytes);

      const worker = yield* stack.deploy(
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
        yield* expectWorkerResponse(worker.url, {
          body: "alchemy-bundle-false-test/7f1c",
          header: "x-alchemy-sentinel",
        });
      }

      // Re-deploy with no changes: hash must remain stable.
      const reDeployed = yield* stack.deploy(
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

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
);

test.provider("bundle: false uploads imported sibling modules", (stack) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { accountId } = yield* CloudflareEnvironment;
    const mainWithImport = path.resolve(
      import.meta.dirname,
      "preBundledWorkerWithImport.mjs",
    );

    yield* stack.destroy();

    const worker = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("BundleFalseWorkerWithImport", {
          main: mainWithImport,
          bundle: false,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    if (worker.url) {
      yield* expectWorkerResponse(worker.url, {
        body: "alchemy-bundle-false-imported-module/4d2a",
        header: "x-alchemy-imported-sentinel",
      });
    }

    yield* stack.destroy();
    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
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
class WorkerResponseNotReady extends Data.TaggedError(
  "WorkerResponseNotReady",
)<{
  body: string;
  header: string | null;
}> {}

const expectWorkerResponse = Effect.fn(function* (
  url: string,
  expected: { body: string; header: string },
) {
  const actual = yield* Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => fetch(url));
    const body = yield* Effect.tryPromise(() => response.text());
    const header = response.headers.get(expected.header);
    if (body !== expected.body || header !== expected.body) {
      return yield* new WorkerResponseNotReady({ body, header });
    }
    return { body, header };
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof WorkerResponseNotReady,
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
  expect(actual.body).toEqual(expected.body);
  expect(actual.header).toEqual(expected.body);
});
