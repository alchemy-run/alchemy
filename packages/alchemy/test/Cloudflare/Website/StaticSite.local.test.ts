import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  findWorker,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";
import EffectStaticSite, { SiteData } from "./fixtures/effect-static-site.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "staticsite-fixture");
const workerEntry = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const staticSiteProps = (cwd: string): Cloudflare.Website.StaticSiteProps => ({
  command: "bash build.sh",
  shell: true,
  cwd,
  outdir: "dist",
  main: workerEntry,
  workersDev: true,
  compatibility: { date: "2024-01-01" },
});

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("StaticSite dev", () => {
  /**
   * The `dev.command` path: `alchemy dev` skips the build entirely and spawns
   * the command as a long-lived child in the sidecar (`Command.Dev`). The URL
   * the child prints to stdout becomes the site's `url`, and the Worker opts
   * out of local emulation (`dev: { mode: "external" }`) — the dev server IS
   * the site.
   */
  test.provider(
    "StaticSite dev: dev.command serves the site through the external dev server",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-dev-cmd-",
          tempRoot,
          entries: ["src", "build.sh", "serve.mjs", ".gitignore"],
        });

        const marker = "staticsite-dev-command-marker";
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite("DevCmdSite", {
              ...staticSiteProps(cwd),
              dev: {
                command: "bun serve.mjs",
                env: { DEV_MARKER: "staticsite-dev-env-marker" },
              },
            });
          }),
        );

        // The site's url is the dev server's own localhost address,
        // extracted from the child's stdout.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // Content serves through the dev server straight from `src/`.
        yield* expectUrlContains(`${site.url!}/`, marker, {
          timeout: "60 seconds",
          label: "dev.command index",
        });
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "30 seconds",
          label: "dev.command explicit path",
        });

        // `dev.env` reached the spawned child process.
        yield* expectUrlContains(
          `${site.url!}/__dev-env`,
          "staticsite-dev-env-marker",
          {
            timeout: "30 seconds",
            label: "dev.command env forwarding",
          },
        );

        // The build command was skipped — `dist/` was never produced.
        expect(yield* fs.exists(path.join(cwd, "dist"))).toBe(false);

        // No cloud Worker was created (external dev mode still records the
        // real worker name in its stub attributes).
        expect(site.workerName).toBeDefined();
        expect(yield* findWorker(site.workerName, accountId)).toBeUndefined();

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * Without `dev.command`, a dev run falls back to build mode: the build
   * command runs (producing `dist/`) and the Worker serves the built assets
   * from a local simulator — the `url` is a localhost dev-proxy address and
   * no cloud Worker exists.
   */
  test.provider(
    "StaticSite dev: without dev.command the build runs and a local Worker serves the assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-dev-build-",
          tempRoot,
          entries: ["src", "build.sh", ".gitignore"],
        });

        const marker = "staticsite-dev-build-marker";
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite(
              "DevBuildSite",
              staticSiteProps(cwd),
            );
          }),
        );

        // Local identity: the url points at the local dev proxy.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // The build ran — `dist/` exists with the built page.
        expect(yield* fs.exists(path.join(cwd, "dist", "index.html"))).toBe(
          true,
        );

        // The built assets serve through the local Worker simulator.
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "60 seconds",
          label: "dev build-mode assets",
        });

        // No cloud Worker was created.
        expect(yield* findWorker(site.workerName, accountId)).toBeUndefined();

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * `Alchemy.remote()` opts the whole site OUT of local emulation: even in a
   * dev run, the build executes and the Worker deploys to real Cloudflare.
   * Destroy deletes the cloud Worker (the state row is stamped live).
   */
  test.provider(
    "StaticSite dev: Alchemy.remote() deploys the real Worker and destroy removes it",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-dev-remote-",
          tempRoot,
          entries: ["src", "build.sh", ".gitignore"],
        });

        const marker = "staticsite-dev-remote-marker";
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite(
              "RemoteSite",
              staticSiteProps(cwd),
            ).pipe(Alchemy.remote());
          }),
        );

        // Real identity: a non-local URL and a Worker that exists on
        // Cloudflare.
        expect(site.url).toBeDefined();
        expect(site.url).not.toMatch(/^http:\/\/localhost/);
        yield* expectWorkerExists(site.workerName, accountId);

        // The real workers.dev URL serves the built assets.
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "remote() site marker",
        });

        yield* stack.destroy();

        // The cloud Worker is gone after destroy (stamped-mode delete).
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Effectful StaticSite (DESIGN §6.2b): the compiled Effect program IS
// the worker in front of the assets — the existing rolldown effect
// pipeline plus the forced `server.routes` → `runWorkerFirst` compile.
// ─────────────────────────────────────────────────────────────────────

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/** GET `url` until it answers 200, then parse the JSON body. */
const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the backoff so a persistent non-200 fails fast instead of
        // looking like a hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

describe.concurrent("StaticSite dev (effectful)", () => {
  /**
   * The effectful roundtrip in dev: one local worker serves the Effect
   * fetch on `/api/*` (worker-first, compiled from the default
   * `server.routes`), the static shell everywhere else, and the SPA
   * fallback for deep links. The KV namespace bound by the impl is
   * emulated locally (`dev:` id — proof no cloud call ran), and the
   * Durable Object export rides the same virtual entry as a plain effect
   * worker.
   */
  test.provider(
    "effectful StaticSite dev: effect API, static shell, and SPA fallback share one local worker",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* EffectStaticSite;
            // The impl's `yield* SiteData` registers the namespace at the
            // root (registration is idempotent per FQN) — this resolves
            // the SAME row the binding uses.
            const data = yield* SiteData;
            return { data, site };
          }),
        );

        // Local identity: the KV namespace is emulated (`dev:` id) and the
        // site serves from the local dev proxy.
        expect(deployed.data.namespaceId).toMatch(/^dev:/);
        expect(deployed.site.url).toMatch(/^http:\/\/localhost:\d+/);
        const url = deployed.site.url!;

        // The static shell serves at `/` (asset layer, worker not
        // invoked). First hit warms the local bundle, so give it time.
        yield* expectUrlContains(`${url}/`, "effect-staticsite-shell", {
          timeout: "90 seconds",
          label: "dev effectful shell",
        });

        // SPA fallback still answers deep links with the shell — the
        // compiled `runWorkerFirst: ["/api/*"]` must not swallow them.
        yield* expectUrlContains(
          `${url}/app/deep/route`,
          "effect-staticsite-shell",
          { timeout: "30 seconds", label: "dev effectful deep link" },
        );

        // A real asset serves its own bytes, not the shell.
        const asset = yield* expectUrlContains(
          `${url}/data.txt`,
          "effect-staticsite-plain-asset",
          { timeout: "30 seconds", label: "dev effectful plain asset" },
        );
        expect(asset).not.toContain("effect-staticsite-shell");

        // `/api/*` routes worker-first into the Effect fetch: the KV
        // binding round-trips against the local simulator.
        yield* expectUrlContains(
          `${url}/api/kv?key=current&put=hello-local`,
          '"value":"hello-local"',
          { timeout: "30 seconds", label: "dev effectful KV put" },
        );
        yield* expectUrlContains(
          `${url}/api/kv?key=current`,
          '"value":"hello-local"',
          { timeout: "30 seconds", label: "dev effectful KV get" },
        );

        // The Durable Object export works exactly as on a plain effect
        // worker: sequential calls against one DO name observe increasing
        // counts. (Not exact values — the readiness retry may invoke the
        // handler more than once.)
        const first = (yield* getJsonReady(`${url}/api/counter`)) as {
          count: number;
        };
        const second = (yield* getJsonReady(`${url}/api/counter`)) as {
          count: number;
        };
        expect(first.count).toBeGreaterThanOrEqual(1);
        expect(second.count).toBeGreaterThan(first.count);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
