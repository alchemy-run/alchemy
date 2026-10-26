import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { tempRoot } from "./site.ts";

// `dev: true` runs local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/octane-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "octane.config.ts",
  "vite.config.ts",
  "index.html",
  "src",
  "public",
];

describe(
  "Azure.Website.Octane local",
  { tags: ["provider:azure", "provider:azure:website", "local"] },
  () => {
    test.provider(
      "dev runs Octane's own dev server with no Azure resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-octane-azure-local-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Azure.Website.Octane("Web", { rootDir });
            }),
          );

          // The site is the framework's dev server: a localhost URL and no
          // Azure resources (proof no Azure call ran).
          const url = site.url as string;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/);
          expect(site.server).toBeUndefined();
          expect(site.frontDoor).toBeUndefined();
          expect(site.storageAccount).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "OCTANE_AWS_PAGE_MARKER", {
            timeout: "120 seconds",
            label: "dev SSR home page",
          });
          yield* expectUrlContains(`${url}/api/hello?echo=dev`, '"echo":"dev"', {
            label: "server route (dev)",
          });

          // HMR: edit the page in place without re-applying the stack.
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const appPath = path.join(rootDir, "src/App.tsx");
          const app = yield* fs.readFileString(appPath);
          yield* fs.writeFileString(
            appPath,
            app.replace("OCTANE_AWS_PAGE_MARKER", "OCTANE_AZURE_PAGE_MARKER_V2"),
          );
          yield* expectUrlContains(`${url}/`, "OCTANE_AZURE_PAGE_MARKER_V2", {
            timeout: "90 seconds",
            label: "SSR page after HMR edit",
          });

          yield* stack.destroy();
        }),
      { timeout: 600_000 },
    );
  },
);
