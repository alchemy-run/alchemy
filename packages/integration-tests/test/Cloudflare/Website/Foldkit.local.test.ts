import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectDirectStatus, expectUrlContains } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Same rationale as Vite.test.ts: Vite's `vite:build-html` plugin expresses
// emitted asset paths relative to `cwd`, so the temp clone has to live under
// the same workspace root.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureDir = pathe.resolve(import.meta.dirname, "foldkit-fixture");
const workerFixtureDir = pathe.resolve(import.meta.dirname, "foldkit-worker-fixture");
const ssrFixtureDir = pathe.resolve(import.meta.dirname, "foldkit-ssr-fixture");

const fixtureEntries = ["package.json", "vite.config.ts", "src"];
const clientFixtureEntries = ["index.html", ...fixtureEntries];

// The worker fixture as cloned, and with `ssr` configuring Foldkit's dev host
// (no `ssr.build`, which a custom main can't build with).
const workerViteConfigs = [
  ["client-only", undefined],
  [
    "ssr dev host",
    `import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit({ ssr: { serverEntry: "/src/entry.server.ts" } })],
  optimizeDeps: { entries: ["src/entry.ts"] },
});
`,
  ],
] as const;

// Restrict the input memo to fixture sources so the test isn't re-hashing
// the whole monorepo on every deploy.
const memoInclude = ["index.html", "src/**", "package.json", "vite.config.ts"];

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent(
  "Foldkit dev",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:website", "provider:cloudflare:worker"],
  },
  () => {
    // A client-only app gets the SPA fallback in dev that its build derives
    // on deploy: a page load of a deep link is answered with the shell, and
    // the resource's own `assets` still override it (#3183).
    test.provider(
      "Foldkit dev: a client-only app serves its shell for deep links",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-foldkit-dev-spa-",
            tempRoot,
            entries: clientFixtureEntries,
          });
          const navigate = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" };

          const site = yield* stack.deploy(
            Cloudflare.Website.Foldkit("FoldkitSpaLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
            }),
          );
          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

          yield* expectUrlContains(`${site.url!}/counter/42`, "Foldkit Fixture", {
            timeout: "30 seconds",
            label: "foldkit dev spa deep link",
            headers: navigate,
          });

          const overridden = yield* stack.deploy(
            Cloudflare.Website.Foldkit("FoldkitSpaLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
              assets: { notFoundHandling: "none" },
            }),
          );
          yield* expectDirectStatus(`${overridden.url!}/counter/42`, 404, {
            timeout: "30 seconds",
            label: "foldkit dev spa override deep link",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["local"], timeout: 120_000 },
    );

    // The same fallback reaches a custom Worker entry's `env.ASSETS.fetch`,
    // as it does deployed, also when `ssr` configures Foldkit's dev host: it
    // stands down for the Worker, and a custom main always builds client-only.
    for (const [variant, viteConfig] of workerViteConfigs) {
      test.provider(
        `Foldkit dev: a custom main entry serves API routes and deep links (${variant})`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const rootDir = yield* cloneFixture(workerFixtureDir, {
              prefix: `alchemy-foldkit-dev-worker-${variant.replaceAll(" ", "-")}-`,
              tempRoot,
              entries: clientFixtureEntries,
            });
            if (viteConfig !== undefined) {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.writeFileString(pathe.join(rootDir, "vite.config.ts"), viteConfig);
            }

            const site = yield* stack.deploy(
              Cloudflare.Website.Foldkit(
                viteConfig === undefined ? "FoldkitWorkerLocal" : "FoldkitWorkerSsrLocal",
                {
                  rootDir,
                  main: "src/worker.ts",
                  assets: { runWorkerFirst: ["/api/*"] },
                  env: { GREETING: "foldkit-worker-fixture" },
                  compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
                  dev: { port: 0 },
                  memo: { include: memoInclude },
                },
              ),
            );
            expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

            yield* expectUrlContains(`${site.url!}/api/hello`, "foldkit-worker-fixture", {
              timeout: "30 seconds",
              label: "foldkit dev worker api",
            });
            yield* expectUrlContains(`${site.url!}/counter/42`, "Foldkit Fixture", {
              timeout: "15 seconds",
              label: "foldkit dev worker spa fallback",
              headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" },
            });

            yield* stack.destroy();
          }).pipe(logLevel),
        { tags: ["local"], timeout: 120_000 },
      );
    }

    // A server-rendered app names no Worker entry of its own, so workerd
    // serves assets alone in dev and Vite's `ssr` environment stays runnable:
    // the Foldkit plugin renders through it exactly as under the app's own
    // `vite dev`. Each page stamps the `count` query into its markup, which
    // is what tells a render from a served template.
    test.provider(
      "Foldkit dev: a server-rendered app renders through the local dev server",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(ssrFixtureDir, {
            prefix: "alchemy-foldkit-dev-ssr-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Cloudflare.Website.Foldkit("FoldkitSsrLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
            }),
          );

          // Local identity: the url points at the alchemy dev proxy — no
          // cloud Worker exists.
          expect(site.url).toBeDefined();
          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

          // The front page renders on request — a served template would
          // carry an empty `<div id="root">` and no count at all.
          yield* expectUrlContains(`${site.url!}/?count=7`, ">7<", {
            timeout: "30 seconds",
            label: "foldkit dev ssr front page",
          });
          // A deep link is rendered too; nothing is prerendered in dev.
          yield* expectUrlContains(`${site.url!}/counter/42?count=3`, ">3<", {
            timeout: "15 seconds",
            label: "foldkit dev ssr deep link",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["local"], timeout: 120_000 },
    );

    /**
     * `Alchemy.remote()` opts the whole site OUT of local emulation: even under
     * `alchemy dev` the build runs, the fetch handler it emits deploys to real
     * Cloudflare, and destroy deletes the cloud Worker (the state row is
     * stamped live).
     */
    test.provider(
      "Foldkit dev: Alchemy.remote() deploys the real Worker and destroy removes it",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* cloneFixture(ssrFixtureDir, {
            prefix: "alchemy-foldkit-dev-remote-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Cloudflare.Website.Foldkit("FoldkitRemoteSite", {
              rootDir,
              workersDev: true,
              compatibility: {
                date: "2024-09-23",
                flags: ["nodejs_compat"],
              },
              memo: { include: memoInclude },
            }).pipe(Alchemy.remote()),
          );

          // Real identity: a non-local URL and a Worker that exists on
          // Cloudflare.
          expect(site.url).toBeDefined();
          expect(site.url).not.toMatch(/^http:\/\/localhost/);
          yield* expectWorkerExists(site.workerName, accountId);

          // The deployed handler renders the front page on request.
          yield* expectUrlContains(`${site.url!}/?count=7`, ">7<", {
            timeout: "30 seconds",
            label: "remote() foldkit ssr front page in dev mode",
          });
          // The route the fixture prerenders is a file: the query never
          // reaches a render.
          yield* expectUrlContains(`${site.url!}/about/?count=7`, ">0<", {
            timeout: "15 seconds",
            label: "remote() foldkit prerendered page in dev mode",
          });

          yield* stack.destroy();

          // The stamped-live row deletes the real Worker even in a dev run.
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 120_000 },
    );
  },
);
