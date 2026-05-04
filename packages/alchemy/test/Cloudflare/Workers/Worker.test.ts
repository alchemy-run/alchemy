import { adopt } from "@/AdoptPolicy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as R2 from "@/Cloudflare/R2";
import { Stack } from "@/Stack";
import { State } from "@/State";
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

// ── Engine-level adoption ─────────────────────────────────────────────────
//
// The engine always calls `provider.read` when there is no prior state, and
// routes on the returned shape:
//
//   - undefined         → resource doesn't exist, drive a normal create
//   - plain attrs       → resource exists and is owned by us (Worker
//                         determines this from `alchemy:*` tags); silent
//                         adoption regardless of `--adopt`
//   - `Unowned(attrs)`  → resource exists but the tags don't identify us;
//                         the engine fails with `OwnedBySomeoneElse` unless
//                         the user opted in via `adopt(true)` / `--adopt`,
//                         in which case it's a silent takeover.
//
// The tests below use `test.provider`'s scratch state so we can wipe state
// mid-test while leaving the actual Cloudflare Worker in place — simulating
// "the user created/deployed this worker before, but this state store has
// never seen it" (e.g. CLI-driven first deploy on a fresh machine, or a
// state-store reset).

test.provider(
  "owned worker (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Use a fixed physical name so the worker's identity persists
      // across a state-store wipe (otherwise `createWorkerName` would
      // pick a fresh random suffix on the second deploy and we'd just
      // be creating a new worker, not adopting).
      const physicalName = `alchemy-test-owned-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy normally so a real Worker exists on Cloudflare,
      // tagged with this stack/stage/id.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("AdoptableWorker", {
            main,
            name: physicalName,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      expect(initial.workerName).toEqual(physicalName);
      expect(yield* findWorker(physicalName, accountId)).toBeDefined();

      // Phase 2: wipe local state for this resource — the worker stays on
      // Cloudflare. From the next deploy's perspective this looks like a
      // fresh state store that has never seen this resource.
      yield* Effect.gen(function* () {
        const state = yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableWorker",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy *without* `adopt(true)`. The engine calls
      // `provider.read`, the Worker's read sees its own alchemy tags and
      // returns plain (owned) attrs, and the engine silently adopts.
      // No `--adopt` flag is required.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("AdoptableWorker", {
            main,
            name: physicalName,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      expect(adopted.workerName).toEqual(physicalName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableWorker",
        });
      }).pipe(Effect.provide(stack.state));

      expect(persisted?.status).toBeDefined();
      expect(persisted?.attr).toMatchObject({ workerName: physicalName });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(physicalName, accountId);
    }).pipe(logLevel),
);

test.provider("adopt(true) takes over a foreign-tagged worker", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Phase 1: deploy under logical id "Original" with an explicit
    // physical name. The Cloudflare Worker is now tagged
    // `alchemy:id:Original` — i.e. owned by *that* logical resource.
    const physicalName = `alchemy-test-adopt-takeover-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const original = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("Original", {
          main,
          name: physicalName,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: { date: "2024-01-01" },
        });
      }),
    );
    expect(yield* findWorker(original.workerName, accountId)).toBeDefined();
    expect(yield* getWorkerTags(physicalName, accountId)).toContain(
      "alchemy:id:Original",
    );

    // Wipe state for the "Original" entry; the worker stays on Cloudflare.
    yield* Effect.gen(function* () {
      const state = yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "Original",
      });
    }).pipe(Effect.provide(stack.state));

    // Phase 2: redeploy under a *different* logical id with the same
    // physical name and `adopt(true)`. `Worker.read` returns
    // `Unowned(attrs)` because the existing tags identify a different
    // logical id; with adopt enabled the engine takes over and the
    // follow-up create/update rewrites the tags. (The rejection path
    // — same scenario without `adopt(true)` — is covered by the unit
    // tests in `plan.test.ts`.)
    const takenOver = yield* stack
      .deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("Different", {
            main,
            name: physicalName,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      )
      .pipe(adopt(true));

    expect(takenOver.workerName).toEqual(physicalName);

    const newTags = yield* getWorkerTags(physicalName, accountId);
    expect(newTags).toContain("alchemy:id:Different");
    expect(newTags).not.toContain("alchemy:id:Original");

    yield* stack.destroy();
    yield* waitForWorkerToBeDeleted(physicalName, accountId);
  }).pipe(logLevel),
);
