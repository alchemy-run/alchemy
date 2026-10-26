import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { tempRoot } from "./site.ts";

// `dev: true` runs local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

/**
 * SolidStart 2's dev SSR does not run under Bun (`srvx/node` writes
 * `[object Object]`), and the test runner is Bun. The identity case runs
 * always; set `ALCHEMY_TEST_SOLIDSTART_DEV_SSR=1` to run the body
 * assertions on a Node-hosted sidecar.
 */
const runDevSsr = process.env.ALCHEMY_TEST_SOLIDSTART_DEV_SSR === "1";

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/solidstart-app");
const fixtureEntries = [".gitignore", "package.json", "vite.config.ts", "src", "public"];

const deployLocal = (prefix: string) =>
  Effect.gen(function* () {
    const rootDir = yield* cloneFixture(fixtureDir, { prefix, tempRoot, entries: fixtureEntries });
    return Effect.gen(function* () {
      return yield* Azure.Website.SolidStart("Web", {
        rootDir,
        env: { SOLIDSTART_ENV_MARKER: "solidstart-azure-dev-env" },
      });
    });
  });

describe(
  "Azure.Website.SolidStart local",
  { tags: ["provider:azure", "provider:azure:website", "local"] },
  () => {
    test.provider(
      "dev runs SolidStart's own dev server with no Azure resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const program = yield* deployLocal("alchemy-solidstart-azure-local-");
          const site = yield* stack.deploy(program);

          // The site is the framework's dev server: a localhost URL and no
          // Azure resources (proof no Azure call ran).
          expect(site.url as string).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
          expect(site.server).toBeUndefined();
          expect(site.frontDoor).toBeUndefined();
          expect(site.storageAccount).toBeUndefined();
          expect(site.assets).toBeUndefined();

          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );

    test.provider.skipIf(!runDevSsr)(
      "dev serves SSR pages with the site env and API routes",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const program = yield* deployLocal("alchemy-solidstart-azure-local-ssr-");
          const site = yield* stack.deploy(program);
          const url = (site.url as string).replace(/\/$/, "");

          yield* expectUrlContains(`${url}/`, "SOLIDSTART_AWS_PAGE_MARKER", {
            timeout: "120 seconds",
            label: "dev home page",
          });
          yield* expectUrlContains(`${url}/`, "env:solidstart-azure-dev-env", {
            label: "env in SSR (dev)",
          });
          yield* expectUrlContains(`${url}/api/hello?echo=dev`, "SOLIDSTART_AWS_API_MARKER:dev", {
            label: "api route (dev)",
          });

          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );
  },
);
