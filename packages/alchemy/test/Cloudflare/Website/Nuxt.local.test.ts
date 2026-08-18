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

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "nuxt.config.ts",
  "app",
  "server",
  "public",
];

const effectFixtureEntries = [...fixtureEntries, "site.ts"];

const memoInclude = [
  "app/**",
  "server/**",
  "public/**",
  "nuxt.config.ts",
  "package.json",
];

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Nuxt dev", () => {
  test.provider(
    "Nuxt dev: local dev server renders SSR with event.context.cloudflare bindings",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-dev-",
          tempRoot,
          entries: fixtureEntries,
        });

        const bindingMarker = "nuxt-dev-binding-marker";

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace("NuxtDevKV");
            const site = yield* Cloudflare.Website.Nuxt("NuxtLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
              env: {
                TEST_BINDING: bindingMarker,
                SITE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );
        const site = deployed.site;

        // Local identity: the url points at the alchemy dev proxy — no
        // cloud Worker exists — and the KV namespace is emulated (a `dev:`
        // id, proof no cloud API call ran).
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(deployed.siteKv.namespaceId)).toBe(true);

        // SSR page rendered by nitro's dev server behind the proxy.
        yield* expectUrlContains(`${site.url!}/`, "NUXT_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "nuxt dev SSR home page",
        });

        // The SSR page reads `event.context.cloudflare.env.TEST_BINDING` —
        // the dev platform bridge reconstructs the runtime contract over
        // the cloudflare-runtime platform proxy.
        yield* expectUrlContains(`${site.url!}/`, `binding:${bindingMarker}`, {
          timeout: "60 seconds",
          label: "nuxt dev SSR page with event.context.cloudflare.env binding",
        });

        // API route through the same contract.
        yield* expectUrlContains(`${site.url!}/api/hello`, "api-route-ok", {
          timeout: "60 seconds",
          label: "nuxt dev API route",
        });

        // KV binding round-trip against the local simulator, through the
        // platform-proxy bridge (nitro dev worker thread → host workerd).
        const put = yield* putJsonReady<{ put: boolean }>(
          `${site.url!}/api/kv?key=dev-key&value=dev-value`,
        );
        expect(put.put).toBe(true);
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=dev-key`,
        );
        expect(got.value).toBe("dev-value");

        // ── HMR: edit an API route in place. The stack is NOT re-applied —
        // nitro's dev rebuild must pick the change up and serve it through
        // the same alchemy proxy ─────────────────────────────────────────
        const helloPath = path.join(rootDir, "server/api/hello.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace('marker: "api-route-ok"', 'marker: "api-route-v2"'),
        );

        // Bounded poll until nitro's dev rebuild serves the new marker.
        yield* expectUrlContains(`${site.url!}/api/hello`, "api-route-v2", {
          timeout: "90 seconds",
          label: "nuxt dev API route after HMR edit",
        });

        // The binding bridge survived the dev-server reload: the KV binding
        // still round-trips (old key readable, new write lands).
        const stillThere = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=dev-key`,
        );
        expect(stillThere.value).toBe("dev-value");
        const put2 = yield* putJsonReady<{ put: boolean }>(
          `${site.url!}/api/kv?key=post-hmr-key&value=post-hmr-value`,
        );
        expect(put2.put).toBe(true);
        const got2 = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=post-hmr-key`,
        );
        expect(got2.value).toBe("post-hmr-value");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * `Alchemy.remote()` opts the KV namespace OUT of local emulation: even
   * under `alchemy dev` the namespace is created on real Cloudflare and the
   * dev server's binding proxies to it remotely. Out-of-band reads through
   * the cloud API prove the write landed in the real namespace, and destroy
   * (with the state row stamped live) deletes it from the cloud.
   *
   * The dev platform proxy is hosted in the sidecar's runtime stack
   * (`DevContext.runtimeContext` threaded through the framework dev bridge),
   * which includes remote-bindings support — the proxy's internal layer is
   * local-only by design.
   */
  test.provider(
    "Nuxt dev: Alchemy.remote() KV namespace runs live behind the dev server",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-dev-remote-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace(
              "NuxtDevRemoteKV",
            ).pipe(Alchemy.remote());
            const site = yield* Cloudflare.Website.Nuxt("NuxtRemoteKvLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
              env: {
                TEST_BINDING: "nuxt-dev-remote-marker",
                SITE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );
        const site = deployed.site;

        // The site is served locally, but the remote() namespace is REAL —
        // a live cloud id, not a `dev:` fabrication.
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.siteKv.namespaceId).toBeDefined();
        expect(deployed.siteKv.namespaceId).not.toMatch(/^dev:/);

        // Write through the dev server's remote-proxied binding.
        const put = yield* putJsonReady<{ put: boolean }>(
          `${site.url!}/api/kv?key=remote-key&value=remote-value`,
        );
        expect(put.put).toBe(true);
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
    { timeout: 300_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // The mount design (Serve/DESIGN.md), dev half: the user's own
  // `server/middleware` mount is ordinary app code nitro compiles into
  // its dev SSR worker thread — nothing is injected. The KV capability
  // collected at plan resolves through the platform proxy to the LOCAL
  // simulator (`dev:` namespace id — proof no cloud call ran). Non-fetch
  // handlers (queue/scheduled/DO classes) are hosted in the dev platform
  // proxy's workerd, not the dev SSR worker.
  // ─────────────────────────────────────────────────────────────────────
  test.provider(
    "Nuxt dev: effectful site serves /api/* through the user's middleware mount",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-effect-dev-",
          tempRoot,
          entries: effectFixtureEntries,
        });

        // The mount — HTTP composition is user code (a nitro server
        // middleware in the served tree), claiming the same routes the
        // fixture's old `server.routes` did: `/api/*` minus the
        // `!/api/hello` exclusion, which stays nitro's.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const middlewareDir = path.join(rootDir, "server", "middleware");
        yield* fs.makeDirectory(middlewareDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(middlewareDir, "alchemy-mount.ts"),
          [
            `import { mount } from "alchemy/Serve";`,
            `import { defineEventHandler, toWebRequest } from "h3";`,
            `import Site from "../../site.ts";`,
            ``,
            `const site = mount(Site, { routes: ["/api/*", "!/api/hello"] });`,
            ``,
            `export default defineEventHandler((event) => {`,
            `  const cloudflare = event.context.cloudflare;`,
            `  return site.fetch(toWebRequest(event), cloudflare?.env, cloudflare?.context);`,
            `});`,
            ``,
          ].join("\n"),
        );

        // The site module is imported from the CLONE (its `main:
        // import.meta.url` anchor must point at the tree nitro serves),
        // so the class is loaded dynamically, per test run.
        const site = yield* importEffectSite(rootDir, "site.ts");

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const attrs = yield* site.default;
            const kv = yield* site.EffectKv!;
            return { attrs, kv };
          }),
        );

        // Local identity: dev proxy URL + `dev:` KV namespace id — the
        // effect-collected binding was served by the local simulator.
        expect(deployed.attrs.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(deployed.kv.namespaceId)).toBe(true);

        const base = deployed.attrs.url!;

        // Effect fetch through the user's mount.
        const marker = yield* fetchJsonReady<{ marker: string }>(
          `${base}/api/effect/marker`,
        );
        expect(marker.marker).toBe("nuxt-effect-dev");

        // KV capability round-trip against the local simulator.
        const put = yield* putJsonReady<{ put: boolean }>(
          `${base}/api/effect/kv?key=dev-key&value=dev-value`,
        );
        expect(put.put).toBe(true);
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${base}/api/effect/kv?key=dev-key`,
        );
        expect(got.value).toBe("dev-value");

        // Exclusion glob routes to the framework: `!/api/hello` carves the
        // path out of the mount's claim, so nitro's own scanned route
        // answers — the effect fetch never runs for it.
        yield* expectUrlContains(`${base}/api/hello`, "api-route-ok", {
          timeout: "60 seconds",
          label: "nitro route via exclusion glob",
        });

        // Unknown route inside the claim is the effect's OWN 404: the
        // fixture's RouteNotFound renders as an empty 404 — never nitro's
        // 404 payload.
        const missingClient = yield* HttpClient.HttpClient;
        const missing = yield* missingClient.get(`${base}/api/nope`);
        expect(missing.status).toBe(404);
        expect(yield* missing.text).not.toContain("<html");

        // Nuxt SSR outside the effect routes is untouched.
        yield* expectUrlContains(`${base}/`, "NUXT_PAGE_MARKER", {
          timeout: "60 seconds",
          label: "nuxt dev SSR page alongside the mount",
        });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  test.provider(
    "Nuxt dev: without a mount, nothing serves the effect fetch (no injection)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-nomount-dev-",
          tempRoot,
          entries: effectFixtureEntries,
        });

        const site = yield* importEffectSite(rootDir, "site.ts");
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const attrs = yield* site.default;
            return { attrs };
          }),
        );
        const base = deployed.attrs.url!;

        // The app itself is up (nitro's own scanned route answers).
        yield* expectUrlContains(`${base}/api/hello`, "api-route-ok", {
          timeout: "60 seconds",
          label: "nitro route without a mount",
        });

        // The purge regression pin (Serve/DESIGN.md): with no
        // `server/middleware` mount in the served tree, the effect fetch
        // has NO HTTP surface — nothing is injected, scanned, or stood
        // down; the paths a mount would claim fall to nitro's own 404.
        const client = yield* HttpClient.HttpClient;
        const claimed = yield* client.get(`${base}/api/effect/marker`);
        expect(claimed.status).toBe(404);
        expect(yield* claimed.text).not.toContain("nuxt-effect-dev");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});

/** Structural shape of a dynamically imported effect site fixture module. */
interface EffectSiteModule {
  readonly default: Effect.Effect<{
    url?: string | undefined;
    workerName: string;
  }>;
  readonly EffectKv?: Effect.Effect<{ namespaceId: string }>;
}

/** Import a site module from a fixture clone (path computed at runtime). */
const importEffectSite = (rootDir: string, file: string) =>
  Effect.tryPromise({
    try: async () => {
      const { pathToFileURL } = await import("node:url");
      return (await import(
        pathToFileURL(pathe.join(rootDir, file)).href
      )) as EffectSiteModule;
    },
    catch: (cause) =>
      new Error(`failed to import effect site module ${file}: ${cause}`),
  });

/** GET `url` until it answers 200 with a JSON body. */
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
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 10,
      }),
    );
  });

/** PUT (empty body) to `url` until it answers 200 with a JSON body. */
const putJsonReady = <T>(url: string) =>
  HttpClient.execute(HttpClientRequest.put(url)).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.flatMap(res.text, (responseBody) =>
            Effect.try({
              try: () => JSON.parse(responseBody) as T,
              catch: () => new Error(`non-json body: ${responseBody}`),
            }),
          )
        : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("500 millis"),
        Schedule.spaced("2 seconds"),
      ]),
      times: 10,
    }),
  );
