import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

/** Titles of KV namespaces auto-provisioned for the given logical id. */
const listSessionNamespaces = (accountId: string, idFragment: string) =>
  kv.listNamespaces.items({ accountId }).pipe(
    Stream.filter((ns) => ns.title.includes(idFragment)),
    Stream.map((ns) => ns.title),
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  );

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
        entries: ["package.json", "public", "src"],
      });

      // Restrict the input memo to fixture sources so the test isn't
      // re-hashing the whole monorepo on every deploy.
      const memoInclude = ["src/**", "public/**", "package.json"];

      // A random value is fine here — it is binding data, not a resource
      // name — and it stays constant across this test's deploys so the
      // metadata hash cannot mask a broken input-hash memo.
      const marker = `astro-marker-${Date.now()}`;

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Astro("AstroSite", {
              rootDir,
              url: true,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: {
                date: "2026-03-10",
                flags: ["nodejs_compat"],
              },
              memo: { include: memoInclude },
              env: { TEST_MARKER: marker },
              assets: {
                htmlHandling: "auto-trailing-slash",
                notFoundHandling: "none",
              },
            });
          }),
        );

      // ── deploy 1: build + serve ────────────────────────────────────────
      const site1 = yield* deploy();
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
      const sessionNamespaces = yield* listSessionNamespaces(
        accountId,
        "AstroSiteSession",
      );
      expect(sessionNamespaces.length).toBe(1);

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
      const site2 = yield* deploy();
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

      const site3 = yield* deploy();
      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, "Astro Fixture Edited", {
        timeout: "60 seconds",
        label: "edited SSR page",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);

      // Destroy must also clean up the auto-provisioned session namespace.
      yield* listSessionNamespaces(accountId, "AstroSiteSession").pipe(
        Effect.filterOrFail(
          (titles) => titles.length === 0,
          (titles) =>
            new SessionFetchFailed({
              url: "kv.listNamespaces",
              message: `session namespace(s) survived destroy: ${titles.join(", ")}`,
            }),
        ),
        Effect.retry({
          schedule: Schedule.spaced("3 seconds"),
          times: 10,
        }),
      );
    }).pipe(logLevel),
  { timeout: 360_000 },
);
