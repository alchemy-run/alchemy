import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "astro-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

test.provider(
  "Astro dev: local dev server renders SSR with bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-astro-dev-",
        tempRoot,
        entries: ["astro.config.mjs", "package.json", "public", "src"],
      });

      const marker = "astro-dev-marker";

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Astro("AstroLocal", {
            rootDir,
            dev: { port: 0 },
            memo: {
              include: [
                "src/**",
                "public/**",
                "astro.config.mjs",
                "package.json",
              ],
            },
            env: { TEST_MARKER: marker },
          });
        }),
      );

      // Local identity: the url points at the alchemy dev proxy — no
      // cloud Worker exists.
      expect(site.url).toBeDefined();
      expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

      // SSR page rendered by astro's dev server (ssr environment runs
      // in workerd behind the proxy) — reads the TEST_MARKER binding.
      yield* expectUrlContains(`${site.url!}/`, marker, {
        timeout: "120 seconds",
        label: "astro dev SSR home with env binding",
      });

      // Prerendered route renders on demand in dev.
      yield* expectUrlContains(`${site.url!}/about/`, "prerendered-page", {
        timeout: "60 seconds",
        label: "astro dev prerender route",
      });

      // Static asset from `public/` through the dev server.
      yield* expectUrlContains(
        `${site.url!}/static.txt`,
        "astro-static-asset",
        {
          timeout: "60 seconds",
          label: "astro dev static asset",
        },
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
