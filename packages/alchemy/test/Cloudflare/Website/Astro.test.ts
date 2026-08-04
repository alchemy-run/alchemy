import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures/astro-app");
const staticFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures/astro-static-app",
);

// Keep the temp clone under the alchemy package so the project root stays
// within the workspace (same constraint as the Vite tests) and so the
// fixture's `astro` dependency resolves by walking up to
// `packages/alchemy/node_modules`.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

class SessionFetchFailed extends Data.TaggedError("SessionFetchFailed")<{
  url: string;
  message: string;
}> {}

/**
 * Cookie-aware fetch for the session round-trip: returns the body plus
 * the `astro-session` cookie pair from `set-cookie` (if any).
 */
const fetchSession = (url: string, cookie?: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: {
          "cache-control": "no-cache",
          accept: "*/*",
          ...(cookie ? { cookie } : {}),
        },
      });
      const body = await res.text();
      const sessionCookie = res.headers
        .get("set-cookie")
        ?.match(/astro-session=[^;,\s]+/)?.[0];
      return { status: res.status, body, sessionCookie };
    },
    catch: (e) =>
      new SessionFetchFailed({
        url,
        message: e instanceof Error ? e.message : String(e),
      }),
  });

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists") {}

const waitForNamespaceToBeDeleted = Effect.fn(function* (
  namespaceId: string,
  accountId: string,
) {
  yield* kv.getNamespace({ accountId, namespaceId }).pipe(
    Effect.flatMap(() => Effect.fail(new NamespaceStillExists())),
    Effect.retry({
      while: (e): e is NamespaceStillExists =>
        e instanceof NamespaceStillExists,
      schedule: Schedule.exponential(250),
      times: 10,
    }),
    Effect.catchTag("NamespaceNotFound", () => Effect.void),
  );
});

test.provider(
  "Astro: SSR + env binding + prerender + static assets deploy; unchanged sources memo-skip the rebuild",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-astro-",
        tempRoot,
        entries: ["astro.config.mjs", "package.json", "public", "src"],
      });

      // Restrict the input memo to fixture sources so the test isn't
      // re-hashing the whole monorepo on every deploy. `workspaces: []`
      // pins the hash to the fixture alone: auto-detection would fold in
      // workspace-linked integration packages, whose trees can change
      // between deploys (concurrent development in this repo), breaking
      // the unchanged-rebuild memo assertion below. Workspace-aware
      // memoization has its own dedicated test in Vite.test.ts.
      const memo = {
        include: ["src/**", "public/**", "package.json", "astro.config.mjs"],
        workspaces: [],
      };

      // A random value is fine here — it is binding data, not a resource
      // name — and it stays constant across this test's deploys so the
      // metadata hash cannot mask a broken input-hash memo.
      const marker = `astro-marker-${Date.now()}`;

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const site = yield* Cloudflare.Website.Astro("AstroSite", {
              rootDir,
              workersDev: { enabled: true, previewsEnabled: true },
              // `nodejs_compat` deliberately omitted — the resource
              // auto-injects it, and this deploy proves that path.
              compatibility: { date: "2026-03-10" },
              memo,
              env: { TEST_MARKER: marker },
              assets: {
                htmlHandling: "auto-trailing-slash",
                notFoundHandling: "none",
              },
            });
            // Resource creation dedupes by logical id, so this returns the
            // session namespace the Astro resource auto-provisioned — a
            // handle for the out-of-band lifecycle assertions below.
            const sessions = yield* Cloudflare.KV.Namespace("AstroSiteSession");
            return { site, sessions };
          }),
        );

      // ── deploy 1: build + serve ────────────────────────────────────────
      const { site: site1, sessions } = yield* deploy();
      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // SSR page rendered in the Worker, reading the env binding.
      yield* expectUrlContains(`${site1.url!}/`, marker, {
        timeout: "120 seconds",
        label: "SSR page renders env binding",
      });
      // Prerendered page served from static assets.
      yield* expectUrlContains(`${site1.url!}/about/`, "prerendered-page", {
        timeout: "60 seconds",
        label: "prerendered page",
      });
      // Plain static asset from public/.
      yield* expectUrlContains(
        `${site1.url!}/static.txt`,
        "astro-static-asset",
        {
          timeout: "60 seconds",
          label: "static asset",
        },
      );

      // ── sessions: the SESSION KV namespace is auto-provisioned and
      // `Astro.session` round-trips through it ───────────────────────────
      expect(sessions.namespaceId).toBeDefined();
      const actualSessions = yield* kv.getNamespace({
        accountId,
        namespaceId: sessions.namespaceId,
      });
      expect(actualSessions.id).toEqual(sessions.namespaceId);

      // Wait for the route to serve before the cookie round-trip.
      yield* expectUrlContains(`${site1.url!}/session`, "session-count=", {
        timeout: "60 seconds",
        label: "session page",
      });

      const first = yield* fetchSession(`${site1.url!}/session`);
      expect(first.status).toBe(200);
      expect(first.body).toContain("session-count=1");
      expect(first.sessionCookie).toBeDefined();

      // Replaying the session cookie must observe the previous request's
      // KV write. Retry through KV's (brief, same-colo) read lag.
      const second = yield* fetchSession(
        `${site1.url!}/session`,
        first.sessionCookie,
      ).pipe(
        Effect.filterOrFail(
          (res) => res.body.includes("session-count=2"),
          (res) =>
            new SessionFetchFailed({
              url: `${site1.url!}/session`,
              message: `expected session-count=2, got: ${res.body.slice(0, 240)}`,
            }),
        ),
        Effect.retry({
          schedule: Schedule.exponential("1 second", 1.5),
          times: 8,
        }),
      );
      expect(second.body).toContain("session-count=2");

      // ── deploy 2: nothing changed ⇒ memo hit (no rebuild) ──────────────
      const { site: site2 } = yield* deploy();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.hash?.bundle).toEqual(site1.hash?.bundle);
      expect(site2.hash?.assets).toEqual(site1.hash?.assets);

      // ── deploy 3: edit a page ⇒ memo busts, new content serves ─────────
      const indexPath = path.join(rootDir, "src/pages/index.astro");
      const source = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        source.replace("Astro Fixture", "Astro Fixture Edited"),
      );

      const { site: site3 } = yield* deploy();
      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, "Astro Fixture Edited", {
        timeout: "60 seconds",
        label: "edited SSR page",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);

      // Destroy must also clean up the auto-provisioned session namespace.
      yield* waitForNamespaceToBeDeleted(sessions.namespaceId, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

class NotFoundPageMismatch extends Data.TaggedError("NotFoundPageMismatch")<{
  url: string;
  actual: string;
}> {}

/**
 * Assert `url` answers a REAL `404` whose body contains `marker` — the
 * built `404.html` served by the asset layer (`notFoundHandling:
 * "404-page"`), not a worker-rendered page and not Cloudflare's
 * placeholder. Retries through edge propagation like `expectUrlContains`
 * (which can't be used here: it requires `res.ok`).
 */
const expectNotFoundPage = (url: string, marker: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      const body = await res.text();
      return { status: res.status, body };
    },
    catch: (e) =>
      new NotFoundPageMismatch({
        url,
        actual: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (res) => res.status === 404 && res.body.includes(marker),
      (res) =>
        new NotFoundPageMismatch({
          url,
          actual: `${res.status} ${res.body.slice(0, 240)}`,
        }),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("750 millis", 1.5),
          Schedule.spaced("8 seconds"),
        ]),
        Schedule.recurs(15),
      ]),
    }),
  );

// ─────────────────────────────────────────────────────────────────────
// Assets-only deploys (seam: SourceBuildOutput.bundle === undefined)
//
// A declared `astro: { output: "static" }` project prerenders every page,
// so the astro source's build produces NO server modules — the source
// path must flow `bundle: undefined` into the WorkerProvider's
// assets-only mode: the script PUT carries no modules and no main_module,
// and Cloudflare's asset layer answers every request (including the built
// 404.html via `notFoundHandling: "404-page"`). Session auto-provisioning
// is skipped — no Worker code could ever read the namespace.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "Astro: output 'static' deploys assets-only — no server bundle, 404.html from assets, memoized rebuilds",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(staticFixtureDir, {
        prefix: "alchemy-astro-static-",
        tempRoot,
        entries: ["package.json", "public", "src"],
      });

      // Same discipline as the SSR test above: pin the input hash to the
      // fixture so concurrent development in this repo can't bust the
      // unchanged-rebuild memo assertion.
      const memo = {
        include: ["src/**", "public/**", "package.json"],
        workspaces: [],
      };

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Astro("AstroStaticSite", {
              rootDir,
              workersDev: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2026-03-10" },
              memo,
              astro: { output: "static" },
              assets: { notFoundHandling: "404-page" },
            });
          }),
        );

      // ── deploy 1: build + assets-only serve ────────────────────────────
      const site1 = yield* deploy();
      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      expect(site1.hash?.assets).toBeDefined();
      // The contract under test: no server bundle was produced or
      // uploaded — the bundle hash slot stays empty.
      expect(site1.hash?.bundle).toBeUndefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // Every page serves from the asset layer.
      yield* expectUrlContains(`${site1.url!}/`, "static-home", {
        timeout: "120 seconds",
        label: "static home page",
      });
      yield* expectUrlContains(`${site1.url!}/about/`, "static-about", {
        timeout: "60 seconds",
        label: "static about page",
      });
      yield* expectUrlContains(
        `${site1.url!}/static.txt`,
        "astro-static-public-asset",
        {
          timeout: "60 seconds",
          label: "public asset",
        },
      );

      // Unknown routes get the BUILT 404.html with a real 404 status —
      // Cloudflare's asset layer applies `notFoundHandling` itself; no
      // Worker script is involved.
      yield* expectNotFoundPage(
        `${site1.url!}/definitely-not-a-page`,
        "static-404",
      );

      // Session auto-provisioning is skipped for declared-static sites:
      // no KV namespace titled for this stack's session id may exist.
      // (Physical titles embed the logical id verbatim:
      // `{stack}-AstroStaticSiteSession-{stage}-{suffix}`.)
      const sessionNamespace = yield* kv.listNamespaces
        .items({ accountId })
        .pipe(
          Stream.filter((ns) => ns.title.includes("AstroStaticSiteSession")),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
      expect(sessionNamespace).toBeUndefined();

      // ── deploy 2: nothing changed ⇒ memo hit, still assets-only ────────
      const site2 = yield* deploy();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.hash?.assets).toEqual(site1.hash?.assets);
      expect(site2.hash?.bundle).toBeUndefined();
      expect(site2.url).toBe(site1.url);

      // ── deploy 3: edit a page ⇒ memo busts, new content serves,
      // and the deploy REMAINS assets-only ───────────────────────────────
      const indexPath = path.join(rootDir, "src/pages/index.astro");
      const source = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        source.replace("static-home", "static-home-v2"),
      );

      const site3 = yield* deploy();
      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      expect(site3.hash?.bundle).toBeUndefined();
      yield* expectUrlContains(`${site3.url!}/`, "static-home-v2", {
        timeout: "60 seconds",
        label: "edited static home page",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);
