import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "waku-app");

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const wakuProps = (rootDir: string) => ({
  rootDir,
  workersDev: { enabled: true, previewsEnabled: true },
  // Deliberately NO `flags`: Waku's server runtime needs
  // AsyncLocalStorage, and the resource must default to `nodejs_als`
  // when the user provides no compatibility flags (a zero-config deploy
  // would otherwise fail at first request).
  compatibility: {
    date: "2026-03-10",
  },
  memo: {
    include: ["src/**", "public/**", "package.json", "tsconfig.json"],
  },
});

test.provider(
  "Waku: deploys RSC SSR + binding + static assets and memoizes unchanged rebuilds",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-waku-",
        tempRoot,
        entries: [
          ".gitignore",
          "package.json",
          "tsconfig.json",
          "public",
          "src",
        ],
      });

      const bindingMarker = "waku-binding-marker";

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Waku("WakuSite", {
              ...wakuProps(rootDir),
              env: {
                MESSAGE: bindingMarker,
              },
            });
          }),
        );

      const site1 = yield* deploy();

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // Dynamic RSC page rendered by the Worker at request time.
      yield* expectUrlContains(`${site1.url!}/`, "WAKU_PAGE_MARKER", {
        timeout: "120 seconds",
        label: "waku dynamic home page",
      });

      // The same page reads the `MESSAGE` binding from `cloudflare:workers`
      // env at request time — proves bindings reach the RSC server bundle.
      yield* expectUrlContains(`${site1.url!}/`, `MESSAGE=${bindingMarker}`, {
        timeout: "60 seconds",
        label: "waku env binding in SSR output",
      });

      // Static asset from `public/`.
      yield* expectUrlContains(
        `${site1.url!}/hello.txt`,
        "hello from public/",
        {
          timeout: "60 seconds",
          label: "waku static asset",
        },
      );

      // SSG page prerendered at build time and served from assets.
      yield* expectUrlContains(
        `${site1.url!}/about`,
        "WAKU_ABOUT_STATIC_MARKER",
        {
          timeout: "60 seconds",
          label: "waku SSG page",
        },
      );

      // The SSG page serves 200 directly at the extensionless URL — the
      // default `drop-trailing-slash` asset handling must not 307-redirect
      // `/about` to `/about/`.
      yield* expectDirectStatus(`${site1.url!}/about`, 200, {
        label: "waku SSG page serves without a redirect",
      });

      // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
      // the deploy short-circuits without rebuilding ───────────────────────
      const site2 = yield* deploy();

      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.url).toBe(site1.url);

      // ── deploy 3: edit a page ⇒ the input hash changes and the new
      // content deploys. The edited marker is asserted on the *dynamic*
      // page (worker-rendered per request) — a changed static asset at the
      // same URL can stay stale at a PoP far longer than a worker-version
      // flip ─────────────────────────────────────────────────────────────
      const indexPath = path.join(rootDir, "src/pages/index.tsx");
      const index = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        index.replace("WAKU_PAGE_MARKER", "WAKU_PAGE_MARKER_V2"),
      );

      const site3 = yield* deploy();

      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, "WAKU_PAGE_MARKER_V2", {
        timeout: "180 seconds",
        label: "waku dynamic page after edit",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 600_000 },
);

// ─────────────────────────────────────────────────────────────────────
// Custom worker entry (seam: WakuProps.main → the waku target's
// user-entry carriage → framework-core's DeployTarget.entry)
//
// `main` points the deploy at the user's own module, which wraps waku's
// emitted handler via `virtual:waku/server-entry` and re-exports the
// `Counter` Durable Object class — DO classes must live on the deployed
// worker for their namespace bindings to resolve. Mirrors
// `Website.Vite`'s "main overrides the worker entry" test.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "Waku: main deploys a custom worker entry hosting a Durable Object",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-waku-main-",
        tempRoot,
        entries: [
          ".gitignore",
          "package.json",
          "tsconfig.json",
          "public",
          "src",
        ],
      });

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Waku("WakuMainSite", {
            ...wakuProps(rootDir),
            // The user's own worker entry: wraps waku's handler (imported
            // from `virtual:waku/server-entry`) and exports the Counter DO.
            main: "src/worker-entry.ts",
            env: {
              MESSAGE: "waku-main-marker",
              COUNTER: Cloudflare.DurableObject("Counter", {
                className: "Counter",
              }),
            },
          });
        }),
      );

      expect(site.url).toBeDefined();
      yield* expectWorkerExists(site.workerName, accountId);

      // The deployed entry is the USER module, not waku's own entry.
      const entry = yield* fetchJsonReady<{ entry: string }>(
        `${site.url!}/api/entry`,
      );
      expect(entry.entry).toBe("worker-entry");

      // The DO namespace is bound and state increments ACROSS requests —
      // instance identity on the deployed worker, through the custom entry.
      const first = yield* fetchJsonReady<{ count: number }>(
        `${site.url!}/api/counter/increment`,
      );
      const second = yield* fetchJsonReady<{ count: number }>(
        `${site.url!}/api/counter/increment`,
      );
      expect(second.count).toBe(first.count + 1);

      const read = yield* fetchJsonReady<{ count: number }>(
        `${site.url!}/api/counter`,
      );
      expect(read.count).toBe(second.count);

      // Wrapping waku's handler keeps every framework route working:
      // the dynamic RSC page still renders (and still reads bindings).
      yield* expectUrlContains(`${site.url!}/`, "WAKU_PAGE_MARKER", {
        timeout: "120 seconds",
        label: "waku dynamic page through the custom entry",
      });
      yield* expectUrlContains(`${site.url!}/`, "MESSAGE=waku-main-marker", {
        timeout: "60 seconds",
        label: "waku env binding through the custom entry",
      });

      // SSG page + public asset still serve from assets alongside the
      // custom entry.
      yield* expectUrlContains(
        `${site.url!}/about`,
        "WAKU_ABOUT_STATIC_MARKER",
        {
          timeout: "60 seconds",
          label: "waku SSG page with custom entry",
        },
      );
      yield* expectUrlContains(
        `${site.url!}/hello.txt`,
        "hello from public/",
        {
          timeout: "60 seconds",
          label: "waku static asset with custom entry",
        },
      );

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 600_000 },
);

/**
 * GET `url` until it answers 200 with a JSON body (fresh workers.dev URLs
 * take a few seconds to start serving; DO namespaces can lag the first
 * deploy). Mirrors Vite.test.ts's helper of the same name.
 */
const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (body) =>
              Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              }),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
  });
