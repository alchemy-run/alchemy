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
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
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

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "sveltekit-app",
);

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const svelteKitProps = (rootDir: string) => ({
  rootDir,
  workersDev: { enabled: true, previewsEnabled: true },
  memo: { include: ["src/**", "static/**", "package.json"] },
});

test.provider(
  "SvelteKit: deploys SSR + bindings + static assets and memoizes unchanged rebuilds",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-sveltekit-",
        tempRoot,
        entries: ["package.json", "src", "static"],
      });

      const bindingMarker = "sveltekit-binding-marker";

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            // A REAL KV namespace bound into `platform.env.SITE_KV` — the
            // /api/kv routes round-trip it server-side.
            const siteKv = yield* Cloudflare.KV.Namespace("SiteKV");
            const site = yield* Cloudflare.Website.SvelteKit("SvelteKitSite", {
              ...svelteKitProps(rootDir),
              env: {
                TEST_BINDING: bindingMarker,
                SITE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );

      const { site: site1, siteKv } = yield* deploy();

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // SSR route: the server `load` reads `platform.env.TEST_BINDING`.
      yield* expectUrlContains(`${site1.url!}/`, `binding:${bindingMarker}`, {
        timeout: "120 seconds",
        label: "SSR home with platform.env binding",
      });

      // API endpoint: node:crypto under nodejs_compat + platform.env.
      const hello = yield* fetchJsonReady<{ uuid: string; binding: string }>(
        `${site1.url!}/api/hello`,
      );
      expect(hello.binding).toBe(bindingMarker);
      expect(hello.uuid).toMatch(/^[0-9a-f-]{36}$/);

      // Static asset from `static/`.
      yield* expectUrlContains(`${site1.url!}/robots.txt`, "User-agent", {
        timeout: "60 seconds",
        label: "static asset",
      });

      // Prerendered page served from assets.
      yield* expectUrlContains(
        `${site1.url!}/prerendered`,
        "this-page-is-prerendered",
        {
          timeout: "60 seconds",
          label: "prerendered page",
        },
      );

      // ── form action: the first non-GET against an alchemy-deployed
      // framework worker. The urlencoded POST must route through the asset
      // layer to the worker, run the `greet` action server-side, and
      // observe `platform.env` ─────────────────────────────────────────────
      const formBody = yield* postFormReady(
        `${site1.url!}/form?/greet`,
        new URL(site1.url!).origin,
        { name: "alchemy" },
      );
      expect(formBody).toContain("result:hello alchemy");
      expect(formBody).toContain(`form-binding:${bindingMarker}`);

      // ── real KV binding: PUT writes through `platform.env.SITE_KV`,
      // GET reads it back, and the cloud API sees the same value ──────────
      expect(siteKv.namespaceId).toBeDefined();
      const kvKey = "greeting";
      const kvValue = `sveltekit-kv-${bindingMarker}`;
      yield* putTextReady(`${site1.url!}/api/kv?key=${kvKey}`, kvValue);
      const kvRead = yield* fetchJsonReady<{ value: string | null }>(
        `${site1.url!}/api/kv?key=${kvKey}`,
      ).pipe(
        Effect.filterOrFail(
          (r) => r.value === kvValue,
          (r) => new Error(`kv value not visible yet: ${JSON.stringify(r)}`),
        ),
        Effect.retry({
          schedule: Schedule.exponential("1 second", 1.5),
          times: 8,
        }),
      );
      expect(kvRead.value).toBe(kvValue);

      // Out-of-band: the worker's write landed in the REAL namespace.
      const cloudValue = yield* kv
        .getNamespaceValue({
          accountId,
          namespaceId: siteKv.namespaceId,
          keyName: kvKey,
        })
        .pipe(
          Effect.flatMap((res) =>
            Effect.tryPromise(() =>
              new Response(
                Stream.toReadableStream(res.body) as BodyInit,
              ).text(),
            ),
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second", 1.5),
            times: 5,
          }),
        );
      expect(cloudValue).toBe(kvValue);

      // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
      // the deploy short-circuits without building ─────────────────────────
      const { site: site2 } = yield* deploy();

      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.url).toBe(site1.url);

      // ── deploy 3: edit a route ⇒ the input hash busts and the rebuilt
      // page serves the new content ────────────────────────────────────────
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pagePath = path.join(rootDir, "src", "routes", "+page.svelte");
      const editedMarker = "sveltekit-edited-marker";
      const page = yield* fs.readFileString(pagePath);
      yield* fs.writeFileString(
        pagePath,
        page.replace(
          "SvelteKit SSR home",
          `SvelteKit SSR home ${editedMarker}`,
        ),
      );

      const { site: site3 } = yield* deploy();

      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, editedMarker, {
        timeout: "120 seconds",
        label: "edited SSR home page",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
      // Destroy must also delete the bound KV namespace from the cloud.
      yield* waitForNamespaceToBeDeleted(siteKv.namespaceId, accountId);
    }).pipe(logLevel),
  // exclusive: the SvelteKit build temporarily switches process.cwd() to
  // the project root (kit resolves config relative to the cwd).
  { timeout: 360_000, exclusive: true },
);

// ─────────────────────────────────────────────────────────────────────
// SPA mode: `adapter.notFoundHandling: "single-page-application"`
//
// Pages are `ssr = false`, so deep links and unknown routes must serve
// the generated app-shell `index.html` (identified by the fixture's
// shell marker), while `+server.ts` endpoints still execute server-side
// in the worker with access to `platform.env`.
// ─────────────────────────────────────────────────────────────────────

const spaFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "sveltekit-spa-app",
);

const SPA_SHELL_MARKER = "sveltekit-spa-shell";

test.provider(
  "SvelteKit SPA: deep links and unknown routes serve the app shell; server endpoints still run in the worker",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(spaFixtureDir, {
        prefix: "alchemy-sveltekit-spa-",
        tempRoot,
        entries: ["package.json", "src"],
      });

      const bindingMarker = "sveltekit-spa-binding-marker";

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.SvelteKit("SvelteKitSpaSite", {
            rootDir,
            workersDev: { enabled: true, previewsEnabled: true },
            memo: { include: ["src/**", "package.json"] },
            adapter: { notFoundHandling: "single-page-application" },
            env: {
              TEST_BINDING: bindingMarker,
            },
          });
        }),
      );

      expect(site.url).toBeDefined();
      // SPA mode still ships a worker: the kit server bundle serves the
      // `+server.ts` endpoints.
      expect(site.hash?.bundle).toBeDefined();
      yield* expectWorkerExists(site.workerName, accountId);

      // (a) A deep link to a CLIENT route serves the app shell — the
      // shell marker is present and the widget markup (which only ever
      // renders in the browser) is absent.
      const widgetsBody = yield* expectSpaShell(`${site.url!}/widgets`);
      expect(widgetsBody).toContain(SPA_SHELL_MARKER);
      expect(widgetsBody).not.toContain("sveltekit-spa-widgets");
      expect(widgetsBody).not.toContain("sprocket");

      // (b) A route that doesn't exist at all serves the shell too — the
      // client router owns 404 handling in SPA mode.
      const unknownBody = yield* expectSpaShell(
        `${site.url!}/definitely/not/a/route`,
      );
      expect(unknownBody).toContain(SPA_SHELL_MARKER);

      // (c) The server endpoint executes in the worker with the binding.
      const widgets = yield* fetchJsonReady<{
        server: boolean;
        message: string | null;
        widgets: Array<{ id: string; name: string }>;
      }>(`${site.url!}/api/widgets`);
      expect(widgets.server).toBe(true);
      expect(widgets.message).toBe(bindingMarker);
      expect(widgets.widgets.map((w) => w.name)).toEqual([
        "sprocket",
        "flange",
        "grommet",
      ]);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site.workerName, accountId);
    }).pipe(logLevel),
  // exclusive: the SvelteKit build temporarily switches process.cwd() to
  // the project root (kit resolves config relative to the cwd).
  { timeout: 360_000, exclusive: true },
);

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

class SpaShellMismatch extends Data.TaggedError("SpaShellMismatch")<{
  url: string;
  actual: string;
}> {}

/**
 * Assert `url` answers 200 with the SPA app-shell body (contains the
 * fixture's shell marker). Retries through edge propagation with a
 * bounded schedule; returns the body for further (negative) assertions.
 */
const expectSpaShell = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "text/html" },
      });
      const body = await res.text();
      return { status: res.status, body };
    },
    catch: (e) =>
      new SpaShellMismatch({
        url,
        actual: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200 && res.body.includes(SPA_SHELL_MARKER),
      (res) =>
        new SpaShellMismatch({
          url,
          actual: `${res.status} ${res.body.slice(0, 240)}`,
        }),
    ),
    Effect.map((res) => res.body),
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

/**
 * POST an urlencoded form to a kit action URL (`/route?/action`) with an
 * `origin` header matching the site (kit's CSRF check) and
 * `accept: text/html` so the action result is server-rendered into the
 * page. Retries until the route serves 200.
 */
const postFormReady = (
  url: string,
  origin: string,
  form: Record<string, string>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({ origin, accept: "text/html" }),
          HttpClientRequest.bodyText(
            new URLSearchParams(form).toString(),
            "application/x-www-form-urlencoded",
          ),
        ),
      )
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`form action not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("4 seconds"),
          ]),
          times: 15,
        }),
      );
  });

/** PUT a text body to `url`, retrying until the route serves 200. */
const putTextReady = (url: string, body: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client
      .execute(
        HttpClientRequest.put(url).pipe(
          HttpClientRequest.bodyText(body, "text/plain"),
        ),
      )
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.void
            : Effect.fail(new Error(`PUT not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("4 seconds"),
          ]),
          times: 15,
        }),
      );
  });

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
