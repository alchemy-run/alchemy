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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nextjs-app");

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd and
// module resolution from the clone walks up into the workspace
// node_modules (next, react, @opennextjs/cloudflare are devDependencies
// of the alchemy package).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const nextjsProps = (rootDir: string) => ({
  rootDir,
  url: true as const,
  subdomain: { enabled: true, previewsEnabled: true },
  memo: {
    include: [
      "app/**",
      "public/**",
      "package.json",
      "jsconfig.json",
      "middleware.js",
      "next.config.mjs",
      "open-next.config.ts",
    ],
  },
});

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
      // Bounded: ~60s of edge propagation, then fail with the last body.
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
    );
  });

test.provider(
  "Nextjs: deploys SSR + binding + static assets, serves prerendered ISR, and memoizes unchanged rebuilds",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-nextjs-",
        tempRoot,
        entries: [
          "package.json",
          "jsconfig.json",
          "next.config.mjs",
          "open-next.config.ts",
          "middleware.js",
          "app",
          "public",
        ],
      });

      const bindingMarker = "nextjs-binding-marker";

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const kv = yield* Cloudflare.KV.Namespace("NextjsFixtureKv");
            return yield* Cloudflare.Website.Nextjs("NextjsSite", {
              ...nextjsProps(rootDir),
              env: {
                TEST_TEXT: bindingMarker,
                FIXTURE_KV: kv,
              },
            });
          }),
        );

      const site1 = yield* deploy();

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);

      // Dynamic (force-dynamic) app-router page rendered by the Worker.
      yield* expectUrlContains(`${site1.url!}/`, "NEXTJS_SSR_MARKER", {
        timeout: "120 seconds",
        label: "nextjs SSR home page",
      });

      // API route handler — the middleware matcher covers /api/*, so the
      // pass-through header also proves middleware executes on deploy.
      const client = yield* HttpClient.HttpClient;
      const helloRes = yield* client
        .get(`${site1.url!}/api/hello`)
        .pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        );
      expect(helloRes.status).toBe(200);
      expect(helloRes.headers["x-fixture-middleware"]).toBe("passed");
      const hello = (yield* helloRes.json) as { hello: string };
      expect(hello.hello).toBe("world");

      // Middleware rewrite: /mw-rewrite serves the API route's response.
      const rewritten = yield* fetchJsonReady<{ hello: string }>(
        `${site1.url!}/mw-rewrite`,
      );
      expect(rewritten.hello).toBe("world");

      // Binding read through OpenNext's `getCloudflareContext()`.
      const binding = yield* fetchJsonReady<{ value: string | null }>(
        `${site1.url!}/api/binding`,
      );
      expect(binding.value).toBe(bindingMarker);

      // KV round-trip through a real resource binding: PUT then GET.
      const kvKey = `nextjs-live-${site1.hash?.input?.slice(0, 8)}`;
      const kvValue = `kv-value-${bindingMarker}`;
      const putRes = yield* client.execute(
        HttpClientRequest.put(`${site1.url!}/api/kv`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ key: kvKey, value: kvValue }),
        ),
      );
      expect(putRes.status).toBe(200);
      const kvRead = yield* fetchJsonReady<{ value: string | null }>(
        `${site1.url!}/api/kv?key=${kvKey}`,
      );
      expect(kvRead.value).toBe(kvValue);

      // Static asset from `public/`.
      yield* expectUrlContains(
        `${site1.url!}/static.txt`,
        "NEXTJS_STATIC_ASSET_MARKER",
        {
          timeout: "60 seconds",
          label: "nextjs static asset",
        },
      );

      // ISR page: the prerendered payload serves (read-only static-assets
      // incremental cache; revalidation writes are a documented no-op).
      yield* expectUrlContains(`${site1.url!}/isr`, "NEXTJS_ISR_MARKER", {
        timeout: "60 seconds",
        label: "nextjs prerendered ISR page",
      });

      // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
      // the deploy short-circuits without rebuilding ───────────────────────
      const site2 = yield* deploy();

      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      expect(site2.url).toBe(site1.url);

      // ── deploy 3: edit the SSR page ⇒ the input hash changes and the
      // new content deploys ────────────────────────────────────────────────
      const pagePath = path.join(rootDir, "app/page.jsx");
      const page = yield* fs.readFileString(pagePath);
      yield* fs.writeFileString(
        pagePath,
        page.replace("NEXTJS_SSR_MARKER", "NEXTJS_SSR_MARKER_V2"),
      );

      const site3 = yield* deploy();

      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, "NEXTJS_SSR_MARKER_V2", {
        timeout: "120 seconds",
        label: "nextjs SSR page after edit",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
