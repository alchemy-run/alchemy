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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd —
// and so `nuxt`/`nitropack` resolve from the workspace's hoisted
// node_modules when the fixture's own tree has none.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const nuxtProps = (rootDir: string) => ({
  rootDir,
  workersDev: { enabled: true, previewsEnabled: true },
  memo: {
    include: [
      "app/**",
      "server/**",
      "public/**",
      "nuxt.config.ts",
      "package.json",
    ],
  },
});

test.provider(
  "Nuxt: deploys SSR + bindings + static assets and memoizes unchanged rebuilds",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-nuxt-",
        tempRoot,
        entries: [
          ".gitignore",
          "package.json",
          "nuxt.config.ts",
          "app",
          "server",
          "public",
        ],
      });

      const bindingMarker = "nuxt-binding-marker";

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Nuxt("NuxtSite", {
              ...nuxtProps(rootDir),
              env: {
                TEST_BINDING: bindingMarker,
              },
            });
          }),
        );

      const site1 = yield* deploy();

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // SSR page: rendered by the Worker at request time.
      yield* expectUrlContains(`${site1.url!}/`, "NUXT_PAGE_MARKER", {
        timeout: "120 seconds",
        label: "SSR home page",
      });

      // The SSR page reads `event.context.cloudflare.env.TEST_BINDING` —
      // proves bindings reach nitro's cloudflare_module runtime contract.
      yield* expectUrlContains(`${site1.url!}/`, `binding:${bindingMarker}`, {
        timeout: "60 seconds",
        label: "SSR page with event.context.cloudflare.env binding",
      });

      // The fixture's own nuxt.config.ts loaded natively — its
      // `runtimeConfig.public.fixtureMarker` renders on the page.
      yield* expectUrlContains(
        `${site1.url!}/`,
        "config:nuxt-user-config-loaded",
        {
          timeout: "60 seconds",
          label: "user nuxt.config.ts applied",
        },
      );

      // API route: reads the binding + waitUntil from the runtime contract.
      const hello = yield* fetchJsonReady<{
        marker: string;
        binding: string | null;
        hasWaitUntil: boolean;
      }>(`${site1.url!}/api/hello`);
      expect(hello.marker).toBe("api-route-ok");
      expect(hello.binding).toBe(bindingMarker);
      expect(hello.hasWaitUntil).toBe(true);

      // Static asset from `public/`.
      yield* expectUrlContains(`${site1.url!}/robots.txt`, "User-agent", {
        timeout: "60 seconds",
        label: "static asset",
      });

      // Route-rule prerendered page, served from assets.
      yield* expectUrlContains(
        `${site1.url!}/prerendered`,
        "this-page-is-prerendered",
        {
          timeout: "60 seconds",
          label: "prerendered page",
        },
      );

      // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
      // the deploy short-circuits without building ─────────────────────────
      const site2 = yield* deploy();

      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.url).toBe(site1.url);

      // ── deploy 3: edit a page ⇒ the input hash changes and the new
      // content deploys. The edited marker is asserted on the *dynamic*
      // page (worker-rendered per request) — a changed static asset at the
      // same URL can stay stale at a PoP far longer than a worker-version
      // flip ─────────────────────────────────────────────────────────────
      const indexPath = path.join(rootDir, "app/pages/index.vue");
      const index = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        index.replace("NUXT_PAGE_MARKER", "NUXT_PAGE_MARKER_V2"),
      );

      const site3 = yield* deploy();

      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, "NUXT_PAGE_MARKER_V2", {
        timeout: "180 seconds",
        label: "SSR page after edit",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 600_000 },
);

/**
 * GET `url` until it answers 200 with a JSON body (fresh workers.dev URLs
 * take a few seconds to start serving). Mirrors SvelteKit.test.ts's
 * helper of the same name.
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
