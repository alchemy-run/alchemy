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

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/sveltekit-app");
const fixtureEntries = [".gitignore", "package.json", "src", "static"];

describe(
  "Azure.Website.SvelteKit local",
  { tags: ["provider:azure", "provider:azure:website", "local"] },
  () => {
    test.provider(
      "dev runs kit's own dev server with no Azure resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-sveltekit-azure-local-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Azure.Website.SvelteKit("Web", { rootDir });
            }),
          );

          // The site is the framework's dev server: a localhost URL and no
          // Azure resources (proof no Azure call ran).
          const url = (site.url as string).replace(/\/$/, "");
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
          expect(site.server).toBeUndefined();
          expect(site.frontDoor).toBeUndefined();
          expect(site.storageAccount).toBeUndefined();
          expect(site.assets).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "SVELTEKIT_AWS_PAGE_MARKER", {
            timeout: "120 seconds",
            label: "dev home page",
          });
          yield* expectUrlContains(
            `${url}/api/hello?echo=dev-roundtrip`,
            '"echo":"dev-roundtrip"',
            {
              label: "api route (dev)",
            },
          );
          yield* expectUrlContains(`${url}/prerendered`, "SVELTEKIT_AWS_PRERENDERED_MARKER", {
            label: "prerendered route (dev)",
          });

          yield* stack.destroy();
        }),
      { timeout: 600_000 },
    );
  },
);
