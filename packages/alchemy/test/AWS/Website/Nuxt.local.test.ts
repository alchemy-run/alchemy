import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");

// Clone under the alchemy package so `nuxt`/`nitropack` resolve from the
// workspace's hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "nuxt.config.ts",
  "app",
  "server",
  "public",
];

describe("AWS.Website.Nuxt local", () => {
  test.provider(
    "dev runs Nuxt's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Nuxt("NuxtSite", {
              rootDir,
              server: {
                environment: {
                  NUXT_PUBLIC_ENV_MARKER: "nuxt-aws-dev-env-marker",
                },
              },
            });
            return { site };
          }),
        );

        // The site is the framework's own dev server: a localhost URL and
        // no cloud rows at all (proof no AWS call ran).
        const url = deployed.site.url! as string;
        expect(url).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/,
        );
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();

        // SSR page served by the nuxt dev server (native HMR toolchain).
        yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // The fixture's own nuxt.config.ts applied in dev too.
        yield* expectUrlContains(
          `${url}/`,
          "config:nuxt-aws-user-config-loaded",
          { label: "user nuxt.config.ts applied (dev)" },
        );
        // server.environment reaches the dev server's process env — the
        // same values the Lambda gets on deploy (dev/live parity).
        yield* expectUrlContains(`${url}/`, "env:nuxt-aws-dev-env-marker", {
          label: "server.environment injected into dev server",
        });
        // Server API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NUXT_AWS_API_MARKER",
          { label: "API route (dev)" },
        );

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
