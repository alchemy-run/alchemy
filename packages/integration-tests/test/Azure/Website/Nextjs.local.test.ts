import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { prepareNextjsFixture } from "../../Cloudflare/Website/TypeScriptCompat.ts";

// `dev: true` runs local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/nextjs-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
  "public",
];

describe(
  "Azure.Website.Nextjs local",
  { tags: ["provider:azure", "provider:azure:website", "local"] },
  () => {
    test.provider(
      "dev runs next dev with no Azure resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
          // Next treat the alchemy monorepo as the workspace root.
          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-nextjs-azure-local-",
            entries: fixtureEntries,
          });
          yield* prepareNextjsFixture(rootDir);

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Azure.Website.Nextjs("Web", { rootDir });
            }),
          );

          // The site is the framework's dev server: a localhost URL and no
          // Azure resources (proof no Azure call ran).
          const url = site.url as string;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
          expect(site.server).toBeUndefined();
          expect(site.frontDoor).toBeUndefined();
          expect(site.storageAccount).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
            timeout: "180 seconds",
            label: "dev home page",
          });
          yield* expectUrlContains(`${url}/api/hello?echo=roundtrip`, "NEXTJS_AWS_API_MARKER", {
            label: "route handler (dev)",
          });
          yield* expectUrlContains(`${url}/static`, "NEXTJS_AWS_STATIC_MARKER", {
            label: "static page (dev)",
          });

          yield* stack.destroy();
        }),
      { timeout: 600_000 },
    );
  },
);
