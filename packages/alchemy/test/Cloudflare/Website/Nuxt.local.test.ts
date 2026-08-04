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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

test.provider(
  "Nuxt dev: local dev server renders SSR with event.context.cloudflare bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-nuxt-dev-",
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

      const bindingMarker = "nuxt-dev-binding-marker";

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Nuxt("NuxtLocal", {
            rootDir,
            dev: { port: 0 },
            memo: {
              include: [
                "app/**",
                "server/**",
                "public/**",
                "nuxt.config.ts",
                "package.json",
              ],
            },
            env: {
              TEST_BINDING: bindingMarker,
            },
          });
        }),
      );

      // Local identity: the url points at the alchemy dev proxy — no
      // cloud Worker exists.
      expect(site.url).toBeDefined();
      expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

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

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
