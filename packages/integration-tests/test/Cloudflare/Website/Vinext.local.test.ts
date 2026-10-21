import * as Cloudflare from "@alchemy.run/cloudflare";
import { isLocalId } from "@alchemy.run/cloudflare/LocalRuntime";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "vinext-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

/**
 * Under `alchemy dev` the site runs locally: vinext's own Vite dev server
 * (the RSC environment in workerd behind the alchemy dev proxy) with the
 * auto-provisioned data-cache KV emulated by the local provider.
 */
describe.concurrent(
  "Vinext dev",
  { tags: ["provider:cloudflare", "provider:cloudflare:kv", "provider:cloudflare:website"] },
  () => {
    test.provider(
      "Vinext dev: local dev server renders SSR and serves public files through ASSETS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vinext-dev-",
            tempRoot,
            entries: [".gitignore", "package.json", "vite.config.ts", "app", "public", "worker"],
          });

          const { site, cache } = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* Cloudflare.Website.Vinext("VinextLocal", {
                rootDir,
                dev: { port: 0 },
                memo: {
                  include: ["app/**", "public/**", "worker/**", "package.json", "vite.config.ts"],
                },
              });
              // Dedupes by logical id: the data-cache namespace the Vinext
              // resource auto-provisioned.
              const cache = yield* Cloudflare.KV.Namespace("VinextLocalIsrCache");
              return { site, cache };
            }),
          );

          // Local identity: the url points at the alchemy dev proxy, and the
          // cache namespace carries the `dev:` marker (no cloud call ran).
          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
          expect(isLocalId(cache.namespaceId)).toBe(true);

          yield* expectUrlContains(`${site.url!}/`, "VINEXT_PAGE_MARKER", {
            timeout: "180 seconds",
            label: "vinext dev SSR home",
          });

          // Static asset from `public/` through the dev server.
          yield* expectUrlContains(`${site.url!}/robots.txt`, "User-agent", {
            timeout: "60 seconds",
            label: "vinext dev static asset",
          });

          // The same file read by a server route through the `ASSETS` binding.
          yield* expectUrlContains(`${site.url!}/api/asset`, "User-agent", {
            timeout: "60 seconds",
            label: "vinext dev ASSETS binding",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );
  },
);
