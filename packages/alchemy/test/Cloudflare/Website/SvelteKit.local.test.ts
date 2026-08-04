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

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "sveltekit-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

test.provider(
  "SvelteKit dev: local dev server renders SSR with platform.env bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-sveltekit-dev-",
        tempRoot,
        entries: ["package.json", "src", "static"],
      });

      const bindingMarker = "sveltekit-dev-binding-marker";

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.SvelteKit("SvelteKitLocal", {
            rootDir,
            dev: { port: 0 },
            memo: { include: ["src/**", "static/**", "package.json"] },
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

      // SSR route: kit's own Vite dev server (Node SSR), with
      // `platform.env` served by the cloudflare-runtime platform proxy
      // and the literal env overlaid.
      yield* expectUrlContains(`${site.url!}/`, `binding:${bindingMarker}`, {
        timeout: "120 seconds",
        label: "sveltekit dev SSR home with platform.env binding",
      });

      // API endpoint: node:crypto + platform.env through the dev server.
      yield* expectUrlContains(
        `${site.url!}/api/hello`,
        `"binding":"${bindingMarker}"`,
        {
          timeout: "60 seconds",
          label: "sveltekit dev API route",
        },
      );

      // Static asset from `static/`.
      yield* expectUrlContains(`${site.url!}/robots.txt`, "User-agent", {
        timeout: "60 seconds",
        label: "sveltekit dev static asset",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  // The kit dev server is cwd-sensitive (same reason the live test is
  // exclusive): `svelte-kit sync` and the config loader resolve from the
  // process working directory.
  { timeout: 300_000, exclusive: true },
);
