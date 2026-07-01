import { adopt } from "@/AdoptPolicy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as R2 from "@/Cloudflare/R2";
import * as Provider from "@/Provider";
import * as Output from "@/Output";
import { Stack } from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  expectWorkersDevPreviews,
  expectWorkersDevSubdomain,
  findWorker,
  getWorkerTags,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";
import type { Counter, Meter } from "./fixtures/do-counter-worker.ts";
import InternalWorker from "./fixtures/internal-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");
const doMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/do-counter-worker.ts",
);

describe.concurrent("Cloudflare.Worker", () => {
  test.provider("create, update, delete worker", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const s = yield* Stack;

      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          yield* R2.Bucket("Bucket", {
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

      // Verify the workers.dev subdomain is enabled on Cloudflare
      // (rather than just trusting the resource's output attributes).
      expect(worker.url).toBeDefined();
      const initialSubdomain = yield* workers.getScriptSubdomain({
        accountId,
        scriptName: worker.workerName,
      });
      expect(initialSubdomain).toEqual({
        enabled: true,
        previewsEnabled: true,
      });

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
      const { accountId } = yield* yield* CloudflareEnvironment;
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

      // Verify the workers.dev subdomain is enabled on Cloudflare
      // (rather than just trusting the resource's output attributes).
      expect(worker.url).toBeDefined();
      const assetsWorkerSubdomain = yield* workers.getScriptSubdomain({
        accountId,
        scriptName: worker.workerName,
      });
      expect(assetsWorkerSubdomain).toEqual({
        enabled: true,
        previewsEnabled: true,
      });

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
        const { accountId } = yield* yield* CloudflareEnvironment;
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
        const { accountId } = yield* yield* CloudflareEnvironment;
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
        const { accountId } = yield* yield* CloudflareEnvironment;
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
      const { accountId } = yield* yield* CloudflareEnvironment;
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
        const { accountId } = yield* yield* CloudflareEnvironment;

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
          const state = yield* yield* State;
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
          const state = yield* yield* State;
          return yield* state.get({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableWorker",
          });
        }).pipe(Effect.provide(stack.state));

        expect(persisted?.status).toBeDefined();
        expect((persisted as any)?.attr).toMatchObject({
          workerName: physicalName,
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(physicalName, accountId);
      }).pipe(logLevel),
  );

  test.provider("adopt(true) takes over a foreign-tagged worker", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

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
        const state = yield* yield* State;
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

  // First-deploy behaviour: the default (omitting `url`) must enable
  // the workers.dev subdomain, and `url: false` must disable it. Both
  // are asserted against live Cloudflare state via `getScriptSubdomain`,
  // not just the resource's output attributes.
  test.provider(
    "url defaults to enabling the workers.dev subdomain on first deploy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("SubdomainDefaultWorker", {
              main,
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

        expect(worker.url).toBeDefined();
        yield* expectWorkersDevSubdomain(worker.workerName, accountId, true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );

  test.provider(
    "url: false disables the workers.dev subdomain on first deploy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("SubdomainDisabledWorker", {
              main,
              url: false,
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

        expect(worker.url).toBeUndefined();
        yield* expectWorkersDevSubdomain(worker.workerName, accountId, false);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );

  // Update regression: toggling `url` between deploys must propagate
  // to the live Cloudflare subdomain state. Before this regression
  // was fixed, the reconciler diffed `news.url !== olds.url` and
  // drove the API call symmetrically — but the new observed-vs-
  // desired check inside reconcile must still flip the toggle when
  // props really do change.
  test.provider(
    "toggling url between deploys flips the workers.dev subdomain",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const deploy = (url: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("SubdomainToggleWorker", {
                main,
                url,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        const v1 = yield* deploy(true);
        expect(v1.url).toBeDefined();
        yield* expectWorkersDevSubdomain(v1.workerName, accountId, true);

        const v2 = yield* deploy(false);
        expect(v2.workerName).toEqual(v1.workerName);
        expect(v2.url).toBeUndefined();
        yield* expectWorkersDevSubdomain(v2.workerName, accountId, false);

        const v3 = yield* deploy(true);
        expect(v3.workerName).toEqual(v1.workerName);
        expect(v3.url).toBeDefined();
        yield* expectWorkersDevSubdomain(v3.workerName, accountId, true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
  );

  // Drift regression: if something external (a previous failed deploy,
  // a Cloudflare dashboard toggle, the bootstrap path in `loginWithCloudflare`)
  // leaves the workers.dev subdomain in `enabled: true, previewsEnabled: false`,
  // a redeploy must observe `previewsEnabled` and flip it back on. The
  // pre-fix reconciler diffed only `enabled` against desired, so it
  // skipped the API call and let the drift persist.
  test.provider(
    "redeploy re-enables previewsEnabled when externally disabled",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        // Deploy with different compatibility dates to force the update.
        const deploy = (date: string) =>
          stack.deploy(
            Cloudflare.Worker("SubdomainPreviewsDriftWorker", {
              main,
              compatibility: { date },
            }),
          );

        const v1 = yield* deploy("2026-01-01");
        yield* expectWorkersDevPreviews(v1.workerName, accountId, {
          enabled: true,
          previewsEnabled: true,
        });

        // Simulate external drift: leave `enabled: true` but turn
        // `previewsEnabled` off out-of-band.
        yield* workers.createScriptSubdomain({
          accountId,
          scriptName: v1.workerName,
          enabled: true,
          previewsEnabled: false,
        });
        const drifted = yield* workers.getScriptSubdomain({
          accountId,
          scriptName: v1.workerName,
        });
        expect(drifted).toEqual({ enabled: true, previewsEnabled: false });

        const v2 = yield* deploy("2026-01-02");
        expect(v2.workerName).toEqual(v1.workerName);
        yield* expectWorkersDevPreviews(v2.workerName, accountId, {
          enabled: true,
          previewsEnabled: true,
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
  );

  // `domains` should reflect the workers.dev URL when the subdomain is
  // enabled and be empty when it isn't. `worker.url` is just `domains[0]`,
  // so the two must stay in lockstep across deploys.
  test.provider(
    "domains reflects the workers.dev subdomain and tracks url",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const deploy = (url: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("DomainsWorker", {
                main,
                url,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        const enabled = yield* deploy(true);
        expect(enabled.domains).toHaveLength(1);
        expect(enabled.domains[0]).toMatch(/\.workers\.dev$/);
        expect(enabled.url).toEqual(enabled.domains[0]);

        const disabled = yield* deploy(false);
        expect(disabled.domains).toEqual([]);
        expect(disabled.url).toBeUndefined();

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(enabled.workerName, accountId);
      }).pipe(logLevel),
  );

  // When custom domains are attached, they come first in `domains` (in
  // the order the user provided them), followed by the workers.dev URL
  // when the subdomain is enabled. `worker.url` is `domains[0]`, so the
  // custom domain wins.
  const customDomainZone = process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME;
  test.provider.skipIf(!customDomainZone)(
    "domains puts custom domains before workers.dev and url is the first",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const suffix = process.env.PULL_REQUEST ?? process.env.USER ?? "local";
        const domainA = `alchemy-worker-a-${suffix}.${customDomainZone}`;
        const domainB = `alchemy-worker-b-${suffix}.${customDomainZone}`;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("CustomDomainWorker", {
              main,
              domain: [domainA, domainB],
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

        expect(worker.domains.slice(0, 2)).toEqual([
          `https://${domainA}`,
          `https://${domainB}`,
        ]);
        expect(worker.domains[2]).toMatch(/\.workers\.dev$/);
        expect(worker.url).toEqual(`https://${domainA}`);

        // Reorder — `domains[0]` should follow.
        const swapped = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("CustomDomainWorker", {
              main,
              domain: [domainB, domainA],
              compatibility: { date: "2024-01-01" },
            });
          }),
        );
        expect(swapped.domains.slice(0, 2)).toEqual([
          `https://${domainB}`,
          `https://${domainA}`,
        ]);
        expect(swapped.url).toEqual(`https://${domainB}`);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );

  // Canonical `list()` test (account collection): deploy a real Worker and
  // assert it shows up in the exhaustively-paginated account-wide listing.
  test.provider("list enumerates the deployed worker", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("ListWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Worker);
      const all = yield* provider.list();

      expect(all.some((w) => w.workerName === worker.workerName)).toBe(true);
      const found = all.find((w) => w.workerName === worker.workerName);
      expect(found?.workerId).toEqual(worker.workerId);
      expect(found?.accountId).toEqual(accountId);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  );

  test.provider(
    "downstream referencing worker.url is not re-updated when the worker changes",
    (stack) =>
      // Regression: a downstream resource that references `worker.url` as a
      // plain prop (e.g. a GitHub Webhook delivery URL built via
      // `Output.interpolate`) must not spuriously re-update every time the
      // upstream worker changes. The worker's url is stable across a
      // code/config change, so the planner must resolve `worker.url` to a
      // concrete value (rather than an unresolved Output, which would make
      // `havePropsChanged` short-circuit on `Output.hasOutputs` and force a
      // phantom update) and plan the downstream as a no-op.
      Effect.gen(function* () {
        yield* stack.destroy();

        // A worker plus a notification webhook whose `url` prop points at the
        // worker (a plain prop dependency, exactly like a GitHub webhook's
        // delivery URL). `crons` is the only thing that varies between the
        // deploy and the re-plan — it forces the worker to plan as an
        // `update` while leaving its url untouched.
        const program = (crons: string[]) =>
          Effect.gen(function* () {
            const worker = yield* Cloudflare.Worker("Upstream", {
              main,
              crons,
              compatibility: { date: "2024-01-01" },
            });
            yield* Cloudflare.Alerting.NotificationWebhook("Hook", {
              url: Output.interpolate`${worker.url}`,
            });
          });

        yield* stack.deploy(program([]));

        // Re-plan with the worker changed (a new cron forces an update) but
        // the webhook identical. The plan is never applied, so the cron is
        // never actually deployed.
        const plan = yield* stack.plan(program(["*/10 * * * *"]));

        const actionOf = (logicalId: string) =>
          Object.values(plan.resources).find(
            (node) => node.resource.LogicalId === logicalId,
          )?.action;

        expect(actionOf("Upstream")).toBe("update");
        expect(actionOf("Hook")).toBe("noop");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test.provider(
    "worker.durableObjectNamespaces stability across DO and worker changes",
    (stack) =>
      // Exercises plan actions for a downstream resource whose props reference
      // `worker.durableObjectNamespaces.<ClassName>`. Scenarios:
      //
      // | Step                         | Worker     | Hook       |
      // |------------------------------|------------|------------|
      // | First deploy (no DO)         | create     | —          |
      // | Add first DO + hook          | update     | create     |
      // | Worker-only change           | update     | noop       |
      // | Add another DO class         | update     | noop       |
      // | Remove a DO class            | update     | update     |
      // | Worker-only change (restored)| update     | noop       |
      // | Swap DO class (add+remove)   | update     | noop       |
      // | Deploy swap + hook follows   | (apply)    | (apply)    |
      // | No further changes           | noop       | noop       |
      // | Remove last DO class         | update     | update     |
      Effect.gen(function* () {
        yield* stack.destroy();

        type DoClass = "Counter" | "Meter";

        const program = (opts: {
          crons: string[];
          dos: ReadonlyArray<DoClass>;
          hookRef: DoClass | null;
        }) =>
          Effect.gen(function* () {
            const bindings: any = {};
            if (opts.dos.includes("Counter")) {
              bindings.Counter = Cloudflare.DurableObject<Counter>("Counter");
            }
            if (opts.dos.includes("Meter")) {
              bindings.Meter = Cloudflare.DurableObject<Meter>("Meter");
            }

            const worker = yield* Cloudflare.Worker("Upstream", {
              main: doMain,
              crons: opts.crons,
              compatibility: { date: "2024-09-23" },
              bindings,
            } as any);

            if (opts.hookRef !== null) {
              // Embed the DO namespace id in the (real, reachable) worker URL so
              // the webhook's live URL validation passes while still depending on
              // `durableObjectNamespaces`. The worker responds 200 to any path.
              yield* Cloudflare.Alerting.NotificationWebhook("Hook", {
                url: Output.interpolate`${worker.url}/${worker.durableObjectNamespaces.pipe(
                  Output.map((namespaces) => namespaces[opts.hookRef!]),
                )}`,
              });
            }
          });

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        // ── First deploy: worker with no DO classes yet ──
        const workerOnlyFirstPlan = yield* stack.plan(
          program({ crons: [], dos: [], hookRef: null }),
        );
        expect(actionOf(workerOnlyFirstPlan, "Upstream")).toBe("create");
        expect(actionOf(workerOnlyFirstPlan, "Hook")).toBeUndefined();

        yield* stack.deploy(program({ crons: [], dos: [], hookRef: null }));

        // ── Add the first DO class + hook referencing it ──
        const addFirstDoPlan = yield* stack.plan(
          program({ crons: [], dos: ["Counter"], hookRef: "Counter" }),
        );
        expect(actionOf(addFirstDoPlan, "Upstream")).toBe("update");
        expect(actionOf(addFirstDoPlan, "Hook")).toBe("create");

        yield* stack.deploy(
          program({ crons: [], dos: ["Counter"], hookRef: "Counter" }),
        );

        // ── Worker-only change, same DO set → hook noop ──
        const workerOnlyPlan = yield* stack.plan(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(workerOnlyPlan, "Upstream")).toBe("update");
        expect(actionOf(workerOnlyPlan, "Hook")).toBe("noop");

        // ── Add a DO class (Meter) while hook still refs Counter → Counter's
        // namespace id is unchanged, so the hook is a noop even though the
        // worker must update to register the new class ──
        const addDoPlan = yield* stack.plan(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter", "Meter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(addDoPlan, "Upstream")).toBe("update");
        expect(actionOf(addDoPlan, "Hook")).toBe("noop");

        yield* stack.deploy(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter", "Meter"],
            hookRef: "Counter",
          }),
        );

        // ── Remove a DO class (Meter) while hook still refs Counter → DO set
        // changed, so the hook must re-plan even though Counter's id is
        // unchanged in the cloud ──
        const removeDoPlan = yield* stack.plan(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(removeDoPlan, "Upstream")).toBe("update");
        expect(actionOf(removeDoPlan, "Hook")).toBe("update");

        yield* stack.deploy(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter"],
            hookRef: "Counter",
          }),
        );

        // ── Same DO set restored → hook noop on another worker-only change ──
        const stableAgainPlan = yield* stack.plan(
          program({ crons: [], dos: ["Counter"], hookRef: "Counter" }),
        );
        expect(actionOf(stableAgainPlan, "Upstream")).toBe("update");
        expect(actionOf(stableAgainPlan, "Hook")).toBe("noop");

        // ── Swap Counter → Meter (add & remove in one step), hook still refs
        // Counter. The worker must update; the hook plans as noop because the
        // persisted Counter namespace id is still carried in state until apply ──
        const swapDoPlan = yield* stack.plan(
          program({
            crons: [],
            dos: ["Meter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(swapDoPlan, "Upstream")).toBe("update");
        expect(actionOf(swapDoPlan, "Hook")).toBe("noop");

        yield* stack.deploy(
          program({
            crons: [],
            dos: ["Meter"],
            hookRef: "Meter",
          }),
        );

        // ── No further changes → noop ──
        const hookFollowsDoPlan = yield* stack.plan(
          program({ crons: [], dos: ["Meter"], hookRef: "Meter" }),
        );
        expect(actionOf(hookFollowsDoPlan, "Upstream")).toBe("noop");
        expect(actionOf(hookFollowsDoPlan, "Hook")).toBe("noop");

        // ── Remove the last DO class entirely while hook still refs Meter →
        // hook must update (plan-only; URL would be invalid to deploy) ──
        const removeLastDoPlan = yield* stack.plan(
          program({ crons: [], dos: [], hookRef: "Meter" }),
        );
        expect(actionOf(removeLastDoPlan, "Upstream")).toBe("update");
        expect(actionOf(removeLastDoPlan, "Hook")).toBe("update");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
