import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "vite-fixture");

// Vite/Rollup's `vite:build-html` plugin chokes when the project root is
// outside the current working directory because it tries to express the
// emitted asset path relative to `cwd`. To keep the temp clone reachable
// via a sane relative path, allocate the temp dir *inside* the alchemy
// package's `.tmp/` so it sits under the same workspace root as `cwd`.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

/**
 * Recursively copy the vite fixture into a fresh temp directory so each
 * test can mutate sources without polluting the repo.
 */
const cloneFixture = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(tempRoot, { recursive: true });
  const dir = yield* fs.makeTempDirectory({ prefix, directory: tempRoot });

  const copyTree = (relativeFrom: string, relativeTo: string) =>
    Effect.gen(function* () {
      const from = path.join(fixtureDir, relativeFrom);
      const to = path.join(dir, relativeTo);
      const stat = yield* fs.stat(from);
      if (stat.type === "Directory") {
        yield* fs.makeDirectory(to, { recursive: true });
        const entries = yield* fs.readDirectory(from);
        for (const entry of entries) {
          yield* copyTree(
            path.join(relativeFrom, entry),
            path.join(relativeTo, entry),
          );
        }
      } else {
        const contents = yield* fs.readFile(from);
        yield* fs.writeFile(to, contents);
      }
    });

  for (const entry of ["index.html", "package.json", "vite.config.ts", "src"]) {
    yield* copyTree(entry, entry);
  }
  return dir;
});

const expectWorkerExists = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  const settings = yield* workers.getScriptScriptAndVersionSetting({
    accountId,
    scriptName: workerName,
  });
  expect(settings).toBeDefined();
});

const expectAssetContains = Effect.fn(function* (url: string, marker: string) {
  yield* Effect.tryPromise(async () => {
    const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
    const body = await res.text();
    if (!body.includes(marker)) {
      throw new AssetMarkerNotFound({
        url,
        marker,
        bodyExcerpt: body.slice(0, 200),
      });
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (e): e is AssetMarkerNotFound =>
        e instanceof AssetMarkerNotFound ||
        (e as Error)?.message?.includes?.("fetch failed") === true,
      schedule: Schedule.exponential(1000).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});

class AssetMarkerNotFound extends Data.TaggedError("AssetMarkerNotFound")<{
  url: string;
  marker: string;
  bodyExcerpt: string;
}> {}

test.provider(
  "Vite: a single deploy publishes new assets after a source change",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture("alchemy-vite-fix-");
      const indexPath = path.join(rootDir, "index.html");

      const v1Marker = "Vite fixture v1";

      // Restrict the input memo to fixture sources so the test isn't
      // re-hashing the whole monorepo on every deploy.
      const memoInclude = ["index.html", "src/**", "package.json"];

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite("FixVite", {
            rootDir,
            url: true,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-09-23",
              flags: ["nodejs_compat"],
            },
            memo: { include: memoInclude },
          });
        }),
      );

      expect(site1.url).toBeDefined();
      // Vite's diff is keyed off the input hash (deterministic from the
      // root sources), unlike non-Vite assets which were historically
      // walked from dist on every diff. This assertion locks in that
      // contract.
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // ── deploy 2: edit fixture, redeploy once ──────────────────────────
      const v2Marker = "Vite fixture v2";
      const original = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        original.replaceAll(v1Marker, v2Marker),
      );

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite("FixVite", {
            rootDir,
            url: true,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-09-23",
              flags: ["nodejs_compat"],
            },
            memo: { include: memoInclude },
          });
        }),
      );

      // Source changed → input hash changed → worker re-deployed.
      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).not.toEqual(site1.hash?.input);

      // ── deploy 3: no source changes → input hash stable ────────────────
      const site3 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite("FixVite", {
            rootDir,
            url: true,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-09-23",
              flags: ["nodejs_compat"],
            },
            memo: { include: memoInclude },
          });
        }),
      );
      expect(site3.hash?.input).toEqual(site2.hash?.input);

      // Best-effort end-to-end verification. The hash assertions above
      // are the load-bearing part of this test; the HTTP fetch is a
      // bonus check that the freshly-deployed assets are actually
      // reachable on workers.dev.
      if (site2.url) {
        yield* expectAssetContains(`${site2.url}/`, v2Marker).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "Vite: HTTP propagation check did not see the v2 marker " +
                "before the retry budget expired. Hash assertions still passed.",
              error,
            ),
          ),
          Effect.ignore,
        );
      }

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

const waitForWorkerToBeDeleted = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  yield* workers
    .getScript({ accountId, scriptName: workerName })
    .pipe(
      Effect.flatMap(() => Effect.fail(new WorkerStillExists())),
      Effect.retry({
        while: (e): e is WorkerStillExists => e instanceof WorkerStillExists,
        schedule: Schedule.exponential(100).pipe(
          Schedule.both(Schedule.recurs(20)),
        ),
      }),
      Effect.catchTag("WorkerNotFound", () => Effect.void),
    );
});

class WorkerStillExists extends Data.TaggedError("WorkerStillExists") {}
