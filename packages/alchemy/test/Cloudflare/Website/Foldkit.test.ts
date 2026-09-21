import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectDirectStatus, expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Same rationale as Vite.test.ts: Vite's `vite:build-html` plugin expresses
// emitted asset paths relative to `cwd`, so the temp clone has to live under
// the same workspace root.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureDir = pathe.resolve(import.meta.dirname, "foldkit-fixture");
const workerFixtureDir = pathe.resolve(
  import.meta.dirname,
  "foldkit-worker-fixture",
);
const ssrFixtureDir = pathe.resolve(import.meta.dirname, "foldkit-ssr-fixture");

const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

// Restrict the input memo to fixture sources so the test isn't re-hashing
// the whole monorepo on every deploy.
const memoInclude = ["index.html", "src/**", "package.json", "vite.config.ts"];

const foldkitProps = (rootDir: string) => ({
  rootDir,
  workersDev: true,
  compatibility: {
    date: "2024-09-23",
    flags: ["nodejs_compat"],
  },
  memo: { include: memoInclude },
});

const htmlPage = (marker: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${marker}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/entry.ts"></script>
  </body>
</html>
`;

describe.concurrent("Foldkit", () => {
  // A client-only build writes no `foldkit.build.json`, and that absence is
  // what gives it the single-page-application fallback: a deep link serves
  // the template and the app's router resolves it. A server-rendered build
  // records itself and gets the opposite — see frontend-frameworks/src/foldkit/source.ts.
  test.provider(
    "Foldkit: a client-only app gets the single-page-application fallback",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-default-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            // Deliberately no `assets` — the derived default is what is
            // under test.
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitDefault",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site.url).toBeDefined();
        expect(site.hash?.input).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        yield* expectUrlContains(`${site.url!}/`, "Foldkit Fixture", {
          timeout: "120 seconds",
          label: "foldkit index",
        });
        // The deep link matches no file; the fallback answers it with the
        // template and the app boots. A declaration still wins over the
        // default; see the next case.
        yield* expectUrlContains(`${site.url!}/counter/42`, "Foldkit Fixture", {
          timeout: "60 seconds",
          label: "foldkit deep link fallback",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // An explicit `assets` wins over the derived default.
  test.provider(
    "Foldkit: an explicit assets config is passed through",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-override-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit("FixFoldkitOverride", {
              ...foldkitProps(rootDir),
              assets: {
                notFoundHandling: "none",
              },
            });
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The app itself still serves...
        yield* expectUrlContains(`${site.url!}/`, "Foldkit Fixture", {
          timeout: "120 seconds",
          label: "foldkit override index",
        });
        // ...but with `notFoundHandling: "none"` the deep link is a miss
        // rather than an index.html fallback.
        yield* expectDirectStatus(`${site.url!}/counter/42`, 404, {
          timeout: "60 seconds",
          label: "foldkit override deep link",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // A client-only Foldkit deployment may carry a Worker entry in front of
  // the assets (API routes, error reporting, Durable Objects). The client
  // build still serves through the ASSETS binding, and the derived
  // single-page-application fallback still applies behind it.
  test.provider(
    "Foldkit: a custom main entry serves API routes alongside the app",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(workerFixtureDir, {
          prefix: "alchemy-foldkit-worker-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit("FixFoldkitWorker", {
              ...foldkitProps(rootDir),
              main: "src/worker.ts",
              assets: {
                runWorkerFirst: ["/api/*"],
              },
              env: {
                GREETING: "foldkit-worker-fixture",
              },
            });
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The Worker entry answers its own route from the binding.
        yield* expectUrlContains(
          `${site.url!}/api/hello`,
          "foldkit-worker-fixture",
          { timeout: "120 seconds", label: "foldkit worker api" },
        );
        // Everything else passes through to the assets binding.
        yield* expectUrlContains(`${site.url!}/`, "Foldkit Fixture", {
          timeout: "60 seconds",
          label: "foldkit worker index",
        });
        // The derived fallback still answers the deep link through
        // `env.ASSETS.fetch`.
        yield* expectUrlContains(`${site.url!}/counter/42`, "Foldkit Fixture", {
          timeout: "60 seconds",
          label: "foldkit worker spa fallback",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // With `ssr.build` the one `vite build` also emits `dist/server/fetch.js`,
  // and that handler is the Worker. The fixture prerenders `/about` and not
  // `/`, and the build keeps the unfilled template out of the client
  // output, so the front page has to reach the handler. Each page stamps
  // the `count` query into its markup, which tells a file served by the
  // asset layer (the count it was built with) from a page rendered on
  // request (the query's).
  test.provider(
    "Foldkit: a server-rendered app deploys its fetch handler and serves the front page from it",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(ssrFixtureDir, {
          prefix: "alchemy-foldkit-ssr-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            // No `main`, no `assets`: the handler and the routing both come
            // from the build.
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitSsr",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The front page renders on request — a served template would
        // carry an empty `<div id="root">` and no count at all.
        yield* expectUrlContains(`${site.url!}/?count=7`, ">7<", {
          timeout: "120 seconds",
          label: "foldkit ssr front page",
        });
        // A prerendered route is a file: the asset layer answers it and the
        // query never reaches a render.
        yield* expectUrlContains(`${site.url!}/about/?count=7`, ">0<", {
          timeout: "60 seconds",
          label: "foldkit ssr prerendered page",
        });
        // A deep link matches no file and is rendered, not answered with a
        // single-page-application fallback.
        yield* expectUrlContains(`${site.url!}/counter/42?count=3`, ">3<", {
          timeout: "60 seconds",
          label: "foldkit ssr deep link",
        });
        // The handler classifies an asset-shaped miss itself.
        yield* expectDirectStatus(`${site.url!}/assets/missing.js`, 404, {
          timeout: "60 seconds",
          label: "foldkit ssr asset miss",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // When `/` itself is prerendered, the build writes `index.html` as a
  // page: the front page is a file, and only the routes the build did not
  // list reach the handler.
  test.provider(
    "Foldkit: a prerendered front page is served as a file",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(ssrFixtureDir, {
          prefix: "alchemy-foldkit-prerendered-",
          tempRoot,
          entries: fixtureEntries,
        });
        yield* fs.writeFileString(
          path.join(rootDir, "src", "prerender.ts"),
          'export const prerenderPaths = ["/"];\n',
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitPrerendered",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The front page is the prerendered file: the query is ignored.
        yield* expectUrlContains(`${site.url!}/?count=7`, ">0<", {
          timeout: "120 seconds",
          label: "foldkit prerendered front page",
        });
        // An unlisted route still renders on request.
        yield* expectUrlContains(`${site.url!}/counter/42?count=3`, ">3<", {
          timeout: "60 seconds",
          label: "foldkit prerendered deep link",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // Editing a source file must change the input hash so the next deploy
  // rebuilds — the memo is keyed on the project tree, not on wall time.
  test.provider(
    "Foldkit: editing a source file republishes the assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-edit-",
          tempRoot,
          entries: fixtureEntries,
        });
        const indexPath = path.join(rootDir, "index.html");

        const v1Marker = "foldkit-v1-marker";
        yield* fs.writeFileString(indexPath, htmlPage(v1Marker));

        const site1 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitEdit",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site1.hash?.input).toBeDefined();
        yield* expectUrlContains(`${site1.url!}/`, v1Marker, {
          timeout: "120 seconds",
          label: "foldkit edit v1",
        });

        const v2Marker = "foldkit-v2-marker";
        yield* fs.writeFileString(indexPath, htmlPage(v2Marker));

        const site2 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Foldkit(
              "FixFoldkitEdit",
              foldkitProps(rootDir),
            );
          }),
        );

        expect(site2.hash?.input).toBeDefined();
        expect(site2.hash?.input).not.toEqual(site1.hash?.input);
        yield* expectUrlContains(`${site2.url!}/`, v2Marker, {
          timeout: "60 seconds",
          label: "foldkit edit v2",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
