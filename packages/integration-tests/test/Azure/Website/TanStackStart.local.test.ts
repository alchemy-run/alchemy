import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { runExpensive } from "../gates.ts";
import {
  assertGroupGone,
  FRONT_DOOR_TIMEOUT,
  frontDoorUrl,
  frontDoorWait,
  getProfile,
  LOCATION,
  logLevel,
  tempRoot,
  viaFrontDoor,
  waitForPage,
} from "./site.ts";

// `dev: true` runs local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/tanstack-start-app",
);
const fixtureEntries = [".gitignore", "package.json", "vite.config.ts", "src", "public"];

describe(
  "Azure.Website.TanStackStart local",
  { tags: ["provider:azure", "provider:azure:website", "local"] },
  () => {
    test.provider(
      "dev runs TanStack Start's own dev server with no Azure resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-tanstack-start-azure-local-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Azure.Website.TanStackStart("Web", {
                rootDir,
                env: { TANSTACK_ENV_MARKER: "tanstack-start-azure-dev-env" },
              });
            }),
          );

          // The site is the framework's dev server: a localhost URL and no
          // Azure resources (proof no Azure call ran).
          const url = site.url as string;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/);
          expect(site.server).toBeUndefined();
          expect(site.frontDoor).toBeUndefined();
          expect(site.storageAccount).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "TANSTACK_AWS_PAGE_MARKER", {
            timeout: "120 seconds",
            label: "dev home page",
          });
          // `env` reaches the dev server's process env through the server function.
          yield* expectUrlContains(`${url}/`, "env:tanstack-start-azure-dev-env", {
            label: "env in a server function (dev)",
          });
          yield* expectUrlContains(`${url}/api/hello?echo=dev`, "TANSTACK_AWS_API_MARKER", {
            label: "server route (dev)",
          });

          yield* stack.destroy();
        }),
      { timeout: 600_000 },
    );

    // ~$0.10/run, 35-55 min: a server build needs Front Door (10-20 min
    // endpoint propagation, 15-30 min profile delete). Run with
    // AZURE_TEST_EXPENSIVE=1.
    test.provider.skipIf(!runExpensive)(
      "Alchemy.remote() deploys the site to Azure during dev",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-tanstack-start-azure-remote-",
            tempRoot,
            entries: fixtureEntries,
          });

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Azure.Website.TanStackStart("Web", {
                rootDir,
                location: LOCATION,
                env: { TANSTACK_ENV_MARKER: "tanstack-start-azure-remote-env" },
                memo: { include: ["src/**", "public/**", "package.json", "vite.config.ts"] },
              });
            }).pipe(Alchemy.remote()),
          );

          // A real Front Door endpoint and a real Function app.
          const url = site.url as string;
          expect(url).toMatch(frontDoorUrl);
          const server = site.server!;
          expect(server.functionAppId).toMatch(/^\/subscriptions\//);

          // Out of band: the live Function app carries the app setting.
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const settings = yield* web.ListWebAppApplicationSettings({
            subscriptionId,
            resourceGroupName: server.resourceGroup,
            name: server.functionAppName,
          });
          expect(settings.properties?.TANSTACK_ENV_MARKER).toBe("tanstack-start-azure-remote-env");

          const home = yield* waitForPage(
            `${url}/`,
            (page) => page.status === 200 && page.body.includes("TANSTACK_AWS_PAGE_MARKER"),
            frontDoorWait,
          );
          expect(viaFrontDoor(home)).toBe(true);
          expect(home.body).toContain("env:tanstack-start-azure-remote-env");

          // Destroy deletes the live resources (rows stamped `live`).
          const groupName = site.resourceGroup!.resourceGroupName;
          const profileGroup = site.frontDoor!.profile.resourceGroup;
          const profileName = site.frontDoor!.profile.profileName;
          yield* stack.destroy();
          expect(yield* getProfile(profileGroup, profileName)).toBeUndefined();
          yield* assertGroupGone(groupName);
        }).pipe(logLevel),
      { timeout: FRONT_DOOR_TIMEOUT },
    );
  },
);
