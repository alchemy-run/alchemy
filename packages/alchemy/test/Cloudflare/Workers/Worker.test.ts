import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as R2 from "@/Cloudflare/R2";
import { Stack } from "@/Stack";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
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

// ─────────────────────────────────────────────────────────────────────
// Asset hashing & keepAssets behavior
//
// `hash.assets` is content-addressed: it must depend only on the bytes
// in the directory, not on where the directory lives. The provider
// uses that hash to decide whether to upload a fresh manifest or tell
// Cloudflare to keep the existing one (`keepAssets: true`). These
// tests pin down the user-visible contract:
//
//   1. Same bytes at a different path → same hash, no re-upload.
//   2. Different bytes (any change) → new hash, re-upload.
//   3. A worker-only change leaves the asset hash alone, so the
//      script update goes out without re-walking the asset tree.
//
// The "moved path" cases also guard against the regression where state
// written by one machine (e.g. a CI runner) recorded an absolute path
// that the next machine couldn't open — the deploy used to crash with
// `NotFound: FileSystem.readDirectory`.
// ─────────────────────────────────────────────────────────────────────

const assetsFixtureDir = pathe.resolve(import.meta.dirname, "assets");

test.provider(
  "Worker assets: relocating to a fresh path with identical bytes preserves hash and keeps assets",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;

      yield* stack.destroy();

      const dirA = yield* cloneFixture(assetsFixtureDir, {
        prefix: "alchemy-worker-assets-a-",
      });
      const dirB = yield* cloneFixture(assetsFixtureDir, {
        prefix: "alchemy-worker-assets-b-",
      });

      const deploy = (assetsDir: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RelocatedAssets", {
              main,
              assets: assetsDir,
              url: true,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

      const v1 = yield* deploy(dirA);
      expect(v1.hash?.assets).toBeDefined();
      yield* expectWorkerExists(v1.workerName, accountId);
      yield* expectUrlContains(`${v1.url!}/index.html`, "Hello from Worker", {
        timeout: "120 seconds",
        label: "v1 served",
      });

      // Wipe dirA before the second deploy. If anything in the apply
      // path still tries to read the previously-recorded directory,
      // this is where we'd fail with NotFound.
      yield* fs.remove(dirA, { recursive: true });

      const v2 = yield* deploy(dirB);

      // Identical bytes ⇒ identical asset hash ⇒ keepAssets path.
      expect(v2.hash?.assets).toEqual(v1.hash?.assets);
      // The script binding stayed live; the URL keeps serving.
      yield* expectUrlContains(`${v2.url!}/index.html`, "Hello from Worker", {
        timeout: "60 seconds",
        label: "v2 served",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Worker assets: editing a file changes the hash and republishes the manifest",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const dir = yield* cloneFixture(assetsFixtureDir, {
        prefix: "alchemy-worker-assets-edit-",
      });
      const indexPath = path.join(dir, "index.html");

      const v1Marker = `worker-assets-v1-${Date.now()}`;
      yield* fs.writeFileString(
        indexPath,
        `<!doctype html><title>${v1Marker}</title><body>${v1Marker}</body>`,
      );

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("EditedAssets", {
              main,
              assets: dir,
              url: true,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

      const v1 = yield* deploy();
      expect(v1.hash?.assets).toBeDefined();
      yield* expectUrlContains(`${v1.url!}/index.html`, v1Marker, {
        timeout: "120 seconds",
        label: "v1 marker",
      });

      const v2Marker = `worker-assets-v2-${Date.now()}`;
      yield* fs.writeFileString(
        indexPath,
        `<!doctype html><title>${v2Marker}</title><body>${v2Marker}</body>`,
      );

      const v2 = yield* deploy();
      expect(v2.hash?.assets).toBeDefined();
      expect(v2.hash?.assets).not.toEqual(v1.hash?.assets);
      yield* expectUrlContains(`${v2.url!}/index.html`, v2Marker, {
        timeout: "60 seconds",
        label: "v2 marker",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Worker assets: a bundle-only change keeps the asset manifest (hash.assets stable)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const dir = yield* cloneFixture(assetsFixtureDir, {
        prefix: "alchemy-worker-assets-bundle-only-",
      });
      // Write the worker entry into a fresh temp dir so we can edit
      // it between deploys to force a bundle hash change without
      // touching the assets directory.
      const workerDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-worker-assets-bundle-only-entry-",
      });
      const workerPath = path.join(workerDir, "worker.ts");
      const writeWorker = (marker: string) =>
        fs.writeFileString(
          workerPath,
          `export default {
  fetch: async () => new Response(${JSON.stringify(`Hello from BundleOnly: ${marker}`)}),
};
`,
        );

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("BundleOnlyChange", {
              main: workerPath,
              assets: dir,
              url: true,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

      yield* writeWorker("v1");
      const v1 = yield* deploy();
      expect(v1.hash?.assets).toBeDefined();
      expect(v1.hash?.bundle).toBeDefined();

      yield* writeWorker("v2");
      const v2 = yield* deploy();
      // Bundle changed (worker source edited) → hash.bundle moves.
      // Assets are byte-identical → hash.assets must not move, and
      // the keepAssets branch must keep the manifest live.
      expect(v2.hash?.bundle).not.toEqual(v1.hash?.bundle);
      expect(v2.hash?.assets).toEqual(v1.hash?.assets);
      yield* expectUrlContains(`${v2.url!}/index.html`, "Hello from Worker", {
        timeout: "60 seconds",
        label: "assets still served after bundle-only change",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
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
