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
            return yield* Cloudflare.Website.SvelteKit("SvelteKitSite", {
              ...svelteKitProps(rootDir),
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

      // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
      // the deploy short-circuits without building ─────────────────────────
      const site2 = yield* deploy();

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

      const site3 = yield* deploy();

      expect(site3.hash?.input).toBeDefined();
      expect(site3.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site3.url!}/`, editedMarker, {
        timeout: "120 seconds",
        label: "edited SSR home page",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  // exclusive: the SvelteKit build temporarily switches process.cwd() to
  // the project root (kit resolves config relative to the cwd).
  { timeout: 360_000, exclusive: true },
);

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
