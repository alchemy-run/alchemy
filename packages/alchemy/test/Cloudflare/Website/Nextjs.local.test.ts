import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { isLocalId } from "@/Cloudflare/LocalRuntime";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { describe, expect } from "alchemy-test";
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
import { linkJsApiTypeScript } from "./TypeScriptCompat.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nextjs-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  "package.json",
  "tsconfig.json",
  "next.config.mjs",
  "open-next.config.ts",
  "middleware.ts",
  "app",
  "pages",
  "public",
];

/** The effectful fixtures additionally need the site modules (`src/`). */
const effectFixtureEntries = [...fixtureEntries, "src", "stubs"];

/**
 * The explicit-tier mount the hmr test writes into the clone
 * (`app/api/effect/[[...slug]]/route.ts`) — the documented Next.js escape
 * hatch: the catch-all route handler is compiled by Next itself, so effect
 * routes work under the real `next dev` (fetch-only).
 */
const explicitRouteSource = [
  // Relative into packages/alchemy/src (see the note in src/site-hmr.ts):
  // the bare "alchemy/serve/next" specifier would resolve through the
  // `import` condition to the unbuilt lib/ in this workspace.
  `import { toRouteHandler } from "../../../../../../src/Serve/next.ts";`,
  `import Site from "../../../../src/site-hmr";`,
  `const handler = toRouteHandler(Site);`,
  `export { handler as GET, handler as POST, handler as PUT,`,
  `         handler as PATCH, handler as DELETE, handler as HEAD,`,
  `         handler as OPTIONS };`,
  ``,
].join("\n");

const memoInclude = [
  "app/**",
  "pages/**",
  "public/**",
  "package.json",
  "tsconfig.json",
  "middleware.ts",
  "next.config.mjs",
  "open-next.config.ts",
];

/** GET `url` until it answers 200 with a JSON body — bounded (~60s). */
const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              })
            : Effect.fail(
                new Error(
                  `Worker not ready (${res.status}): ${body.slice(0, 300)}`,
                ),
              ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
    );
  });

/** PUT a JSON body to the fixture's /api/kv route — bounded (~60s). */
const putKv = (base: string, key: string, value: string) =>
  HttpClient.execute(
    HttpClientRequest.put(`${base}/api/kv`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ key, value }),
    ),
  ).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.flatMap(res.text, (body) =>
            Effect.fail(
              new Error(
                `kv put not ready (${res.status}): ${body.slice(0, 300)}`,
              ),
            ),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
  );

// ─────────────────────────────────────────────────────────────────────
// Preview mode (the default): the OpenNext worker is built and served
// under workerd locally — production parity, no HMR.
// ─────────────────────────────────────────────────────────────────────

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Nextjs dev", () => {
  test.provider(
    "Nextjs dev (preview): OpenNext worker under local workerd with emulated bindings",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-dev-",
          tempRoot,
          entries: fixtureEntries,
        });
        yield* linkJsApiTypeScript(rootDir);

        const bindingMarker = "nextjs-dev-binding-marker";

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace("NextjsDevKV");
            const site = yield* Cloudflare.Website.Nextjs("NextjsLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
              env: {
                TEST_TEXT: bindingMarker,
                FIXTURE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );
        const site = deployed.site;

        // Local identity: the url points at the alchemy dev proxy — no cloud
        // Worker exists — and the KV namespace is emulated (`dev:` id, proof
        // no cloud API call ran).
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(deployed.siteKv.namespaceId)).toBe(true);

        // The SSR page rendered by the OpenNext worker under workerd.
        yield* expectUrlContains(`${site.url!}/`, "NEXTJS_SSR_MARKER", {
          timeout: "120 seconds",
          label: "nextjs dev SSR home page",
        });

        // Binding read through OpenNext's getCloudflareContext().
        const binding = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/binding`,
        );
        expect(binding.value).toBe(bindingMarker);

        // Prerendered ISR page serves from the read-only static-assets cache.
        yield* expectUrlContains(`${site.url!}/isr`, "NEXTJS_ISR_MARKER", {
          timeout: "60 seconds",
          label: "nextjs dev prerendered ISR page",
        });

        // Static asset from public/.
        yield* expectUrlContains(
          `${site.url!}/static.txt`,
          "NEXTJS_STATIC_ASSET_MARKER",
          { timeout: "60 seconds", label: "nextjs dev static asset" },
        );

        // KV round-trip against the local simulator through the worker.
        yield* putKv(site.url!, "dev-key", "dev-value");
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=dev-key`,
        );
        expect(got.value).toBe("dev-value");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 420_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // HMR mode: the real `next dev` (Turbopack) in Node, bindings proxied
  // onto OpenNext's getCloudflareContext() contract.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Nextjs dev (hmr): real next dev serves edits without redeploying",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-dev-hmr-",
          tempRoot,
          entries: fixtureEntries,
        });
        yield* linkJsApiTypeScript(rootDir);

        const bindingMarker = "nextjs-hmr-binding-marker";

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Cloudflare.Website.Nextjs("NextjsHmrLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
              nextjs: { devMode: "hmr" },
              env: {
                TEST_TEXT: bindingMarker,
              },
            });
            return { site };
          }),
        );
        const site = deployed.site;

        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // The SSR page through the real `next dev` (Turbopack).
        yield* expectUrlContains(`${site.url!}/`, "NEXTJS_SSR_MARKER", {
          timeout: "180 seconds",
          label: "nextjs hmr dev SSR home page",
        });

        // getCloudflareContext().env binding through the platform proxy.
        const binding = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/binding`,
        );
        expect(binding.value).toBe(bindingMarker);

        // ── HMR: edit the page in place. The stack is NOT re-applied —
        // Turbopack must recompile and serve the new marker through the
        // same alchemy proxy ─────────────────────────────────────────────
        const pagePath = path.join(rootDir, "app", "page.tsx");
        const page = yield* fs.readFileString(pagePath);
        yield* fs.writeFileString(
          pagePath,
          page.replace("NEXTJS_SSR_MARKER", "NEXTJS_SSR_MARKER_HMR"),
        );
        yield* expectUrlContains(`${site.url!}/`, "NEXTJS_SSR_MARKER_HMR", {
          timeout: "120 seconds",
          label: "nextjs hmr dev page after edit",
        });

        // The binding bridge survived the recompile.
        const still = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/binding`,
        );
        expect(still.value).toBe(bindingMarker);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 420_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Effectful Website, preview mode: the artifact takeover ships in the
  // built worker module set, so effect routes (and the effect program's
  // DO export) work in dev with production parity.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Nextjs dev (preview): artifact takeover serves effect routes, DO export, and framework fallback",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-dev-effect-",
          tempRoot,
          entries: effectFixtureEntries,
        });
        yield* linkJsApiTypeScript(rootDir);

        // Import the site module from the CLONE: its `main: import.meta.url`
        // anchor (and rootDir) must point into the cloned project so the
        // OpenNext build and the takeover prebundle share one root.
        const mod = yield* Effect.promise(
          () =>
            import(pathe.join(rootDir, "src/site.ts")) as Promise<
              typeof import("./fixtures/nextjs-app/src/site.ts")
            >,
        );

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* mod.default;
            const users = yield* mod.EffectUsers;
            return { site, users };
          }),
        );
        const site = deployed.site;

        // Local identity: dev proxy URL + emulated KV namespace (`dev:` id
        // — proof no cloud API call ran).
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(deployed.users.namespaceId)).toBe(true);

        // Effect fetch inside `server.routes` (default /api/*).
        const ping = yield* fetchJsonReady<{ marker: string }>(
          `${site.url!}/api/effect/ping`,
        );
        expect(ping.marker).toBe("effect-fetch");

        // KV round-trip through the collected capability binding against
        // the local simulator.
        const put = yield* HttpClient.execute(
          HttpClientRequest.put(
            `${site.url!}/api/effect/kv?key=effect-key`,
          ).pipe(HttpClientRequest.bodyText("effect-value")),
        ).pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        );
        expect(put.status).toBe(200);
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/effect/kv?key=effect-key`,
        );
        expect(got.value).toBe("effect-value");

        // Non-fetch export: the effect program's Durable Object class is
        // emitted by the takeover wrapper and served by local workerd.
        const count1 = yield* fetchJsonReady<{ count: number }>(
          `${site.url!}/api/effect/count`,
        );
        expect(count1.count).toBe(1);
        const count2 = yield* fetchJsonReady<{ count: number }>(
          `${site.url!}/api/effect/count`,
        );
        expect(count2.count).toBe(2);

        // Passthrough: /api/hello is inside server.routes but not the
        // effect program's — the OpenNext handler (middleware included)
        // serves it.
        const client = yield* HttpClient.HttpClient;
        const hello = yield* client
          .get(`${site.url!}/api/hello`)
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
          );
        expect(hello.status).toBe(200);
        expect(hello.headers["x-fixture-middleware"]).toBe("passed");
        expect(((yield* hello.json) as { hello: string }).hello).toBe("world");

        // Framework surface outside server.routes: SSR page + static asset.
        yield* expectUrlContains(`${site.url!}/`, "NEXTJS_SSR_MARKER", {
          timeout: "120 seconds",
          label: "nextjs effect dev SSR home page",
        });
        yield* expectUrlContains(
          `${site.url!}/static.txt`,
          "NEXTJS_STATIC_ASSET_MARKER",
          { timeout: "60 seconds", label: "nextjs effect dev static asset" },
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 420_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Effectful Website, hmr mode: the real `next dev` cannot serve the
  // takeover artifact — effect routes ride the explicit `toRouteHandler`
  // catch-all mount (fetch-only), compiled by Next itself.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Nextjs dev (hmr): explicit toRouteHandler mount serves effect routes under next dev",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-dev-effect-hmr-",
          tempRoot,
          entries: effectFixtureEntries,
        });
        yield* linkJsApiTypeScript(rootDir);

        // Mount the explicit tier: the catch-all route handler module.
        const routeDir = path.join(
          rootDir,
          "app",
          "api",
          "effect",
          "[[...slug]]",
        );
        yield* fs.makeDirectory(routeDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(routeDir, "route.ts"),
          explicitRouteSource,
        );

        const mod = yield* Effect.promise(
          () =>
            import(pathe.join(rootDir, "src/site-hmr.ts")) as Promise<
              typeof import("./fixtures/nextjs-app/src/site-hmr.ts")
            >,
        );

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* mod.default;
            const users = yield* mod.HmrUsers;
            return { site, users };
          }),
        );
        const site = deployed.site;

        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(deployed.users.namespaceId)).toBe(true);

        // The framework page proves next dev is serving.
        yield* expectUrlContains(`${site.url!}/`, "NEXTJS_SSR_MARKER", {
          timeout: "180 seconds",
          label: "nextjs effect hmr SSR home page",
        });

        // Effect route through the explicit mount (first hit compiles the
        // route + the alchemy graph under turbopack — be patient).
        const ping = yield* fetchJsonReady<{ marker: string }>(
          `${site.url!}/api/effect/ping`,
        );
        expect(ping.marker).toBe("effect-fetch");

        // KV round-trip through the binding proxied onto
        // getCloudflareContext() by the hmr dev server.
        const put = yield* HttpClient.execute(
          HttpClientRequest.put(`${site.url!}/api/effect/kv?key=hmr-key`).pipe(
            HttpClientRequest.bodyText("hmr-value"),
          ),
        ).pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        );
        expect(put.status).toBe(200);
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/effect/kv?key=hmr-key`,
        );
        expect(got.value).toBe("hmr-value");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 420_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Alchemy.remote(): the KV namespace opts OUT of local emulation — real
  // cloud namespace behind the locally-served site.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Nextjs dev: Alchemy.remote() KV namespace runs live behind the dev server",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-dev-remote-",
          tempRoot,
          entries: fixtureEntries,
        });
        yield* linkJsApiTypeScript(rootDir);

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace(
              "NextjsDevRemoteKV",
            ).pipe(Alchemy.remote());
            const site = yield* Cloudflare.Website.Nextjs(
              "NextjsRemoteKvLocal",
              {
                rootDir,
                dev: { port: 0 },
                memo: { include: memoInclude },
                env: {
                  TEST_TEXT: "nextjs-dev-remote-marker",
                  FIXTURE_KV: siteKv,
                },
              },
            );
            return { site, siteKv };
          }),
        );
        const site = deployed.site;

        // Served locally, but the remote() namespace is REAL — a live cloud
        // id, not a `dev:` fabrication.
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.siteKv.namespaceId).toBeDefined();
        expect(deployed.siteKv.namespaceId).not.toMatch(/^dev:/);

        // Write through the worker's remote-proxied binding.
        yield* putKv(site.url!, "remote-key", "remote-value");
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=remote-key`,
        );
        expect(got.value).toBe("remote-value");

        // Out-of-band: the write is visible through the cloud KV API — the
        // remote-proxied binding really hit the live namespace.
        const { accountId } = yield* yield* CloudflareEnvironment;
        const observed = yield* kv
          .getNamespaceValue({
            accountId,
            namespaceId: deployed.siteKv.namespaceId,
            keyName: "remote-key",
          })
          .pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "KeyNotFound",
              schedule: Schedule.min([
                Schedule.exponential("1 second"),
                Schedule.spaced("3 seconds"),
              ]),
              times: 8,
            }),
            Effect.flatMap((res) =>
              Effect.tryPromise(() =>
                new Response(
                  Stream.toReadableStream(res.body) as BodyInit,
                ).text(),
              ),
            ),
          );
        expect(observed).toBe("remote-value");

        yield* stack.destroy();

        // The live namespace was deleted from the cloud on destroy (its
        // state row is stamped live, so the live provider handles the
        // delete even in a dev run).
        const gone = yield* kv
          .getNamespace({
            accountId,
            namespaceId: deployed.siteKv.namespaceId,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
          );
        expect(gone).toBe(true);
      }).pipe(logLevel),
    { timeout: 420_000 },
  );
});
