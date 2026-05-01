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

const fixtureDir = pathe.resolve(import.meta.dirname, "staticsite-fixture");

/**
 * Copy the source-controlled fixture into a fresh temp directory so each
 * test can mutate `src/` and `dist/` independently without polluting the
 * repo or racing with parallel tests.
 */
const cloneFixture = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectory({ prefix });

  // We deliberately do not copy `dist/` — it's a build output. Copy
  // `src/` and `build.sh` so the temp dir is a self-contained
  // StaticSite project.
  yield* fs.makeDirectory(path.join(dir, "src"), { recursive: true });
  const srcEntries = yield* fs.readDirectory(path.join(fixtureDir, "src"));
  for (const entry of srcEntries) {
    const contents = yield* fs.readFileString(
      path.join(fixtureDir, "src", entry),
    );
    yield* fs.writeFileString(path.join(dir, "src", entry), contents);
  }
  const buildScript = yield* fs.readFileString(
    path.join(fixtureDir, "build.sh"),
  );
  const buildScriptPath = path.join(dir, "build.sh");
  yield* fs.writeFileString(buildScriptPath, buildScript);
  yield* fs.chmod(buildScriptPath, 0o755);

  return dir;
});

/**
 * Read the live script settings to confirm a worker exists on Cloudflare.
 * Useful as a deploy-completed checkpoint without taking a propagation
 * dependency on the workers.dev subdomain (which can be slow to surface
 * fresh content).
 */
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

/**
 * Hit the worker URL and assert the response body contains a marker
 * substring. This is best-effort end-to-end verification — Cloudflare's
 * edge can take 30s+ to surface a freshly-deployed asset on a brand-new
 * workers.dev subdomain, so we retry with generous backoff.
 */
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
  "StaticSite: a single deploy publishes new assets after a source change",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const cwd = yield* cloneFixture("alchemy-staticsite-fix-");
      const indexPath = path.join(cwd, "src", "index.html");
      const workerEntry = pathe.resolve(
        import.meta.dirname,
        "../Workers/worker.ts",
      );

      // Scope the build memo to fixture sources. The fixture's `build.sh`
      // appends a per-run nonce to `dist/index.html` to simulate the
      // non-deterministic dist output (Astro/Vite chunk shuffling) that
      // the original bug centred on. If we let `Build.hash` walk the
      // whole cwd by default, that nonce would drift the hash between
      // identical deploys and we'd no longer be able to assert hash
      // stability for the no-change case.
      const memoInclude = ["src/**", "build.sh"];

      // ── deploy 1: initial publish ──────────────────────────────────────
      const v1Marker = "StaticSite fixture v1";
      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite("FixSite", {
            command: "bash build.sh",
            cwd,
            outdir: "dist",
            memo: { include: memoInclude },
            main: workerEntry,
            url: true,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      expect(site1.url).toBeDefined();
      // The worker's stored asset hash equals the build's input hash —
      // a deterministic function of the fixture sources. Before the fix
      // this was a non-deterministic dist walk that drifted every run.
      expect(site1.hash?.assets).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // ── deploy 2: edit fixture, redeploy once ──────────────────────────
      const v2Marker = "StaticSite fixture v2";
      yield* fs.writeFileString(
        indexPath,
        `<!doctype html>
<html>
  <head><title>${v2Marker}</title></head>
  <body><h1>${v2Marker}</h1></body>
</html>
`,
      );

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite("FixSite", {
            command: "bash build.sh",
            cwd,
            outdir: "dist",
            memo: { include: memoInclude },
            main: workerEntry,
            url: true,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      // Source changed → build hash changed → asset hash changed.
      // This is the single-deploy guarantee: one run is enough for the
      // worker to advertise the new asset hash. Before the fix, a stale
      // dist walk during the initial Worker.update could finalize the
      // worker against the *previous* asset manifest, leaving the second
      // deploy to fix it.
      expect(site2.hash?.assets).toBeDefined();
      expect(site2.hash?.assets).not.toEqual(site1.hash?.assets);

      // ── deploy 3: no source changes → no spurious hash drift ───────────
      // build.sh appends a per-run nonce to dist/index.html, so the dist
      // *content* changes every build. Before the fix, that drift caused
      // a phantom `~ Worker` diff on every deploy because diffing was
      // routed through a recomputed dist hash. After the fix, diffing is
      // routed through `build.hash` (input hash) which is stable when
      // src is unchanged.
      const site3 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite("FixSite", {
            command: "bash build.sh",
            cwd,
            outdir: "dist",
            memo: { include: memoInclude },
            main: workerEntry,
            url: true,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      expect(site3.hash?.assets).toEqual(site2.hash?.assets);

      // Best-effort end-to-end verification. The hash assertions above
      // are the load-bearing part of this test; the HTTP fetch is a
      // bonus check that the freshly-deployed assets are actually
      // reachable on workers.dev. We tolerate workers.dev propagation
      // delay via retries, then `Effect.ignore` so a still-warming
      // subdomain doesn't fail the whole test in CI.
      if (site2.url) {
        yield* expectAssetContains(`${site2.url}/index.html`, v2Marker).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "StaticSite: HTTP propagation check did not see the v2 marker " +
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
  { timeout: 240_000 },
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
