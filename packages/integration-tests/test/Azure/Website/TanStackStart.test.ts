import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertGroupGone,
  fetchPage,
  FRONT_DOOR_TIMEOUT,
  frontDoorUrl,
  frontDoorWait,
  getProfile,
  LOCATION,
  logLevel,
  tags,
  tempRoot,
  viaFrontDoor,
  waitForPage,
  webBlob,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../AWS/Website/fixtures/tanstack-start-app",
);
const fixtureEntries = [".gitignore", "package.json", "vite.config.ts", "src", "public"];

describe("Azure.Website.TanStackStart", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  test.provider(
    "SSR on a Flex Consumption Function behind Front Door, assets on Blob Storage",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-tanstack-start-azure-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.TanStackStart("Web", {
              rootDir,
              location: LOCATION,
              env: { TANSTACK_ENV_MARKER: "tanstack-start-azure-app-setting" },
              memo: { include: ["src/**", "public/**", "package.json", "vite.config.ts"] },
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        const server = site.server!;

        // Out of band: the Function app exists and carries the app setting.
        const { subscriptionId } = yield* Azure.AzureEnvironment.current;
        const settings = yield* web.ListWebAppApplicationSettings({
          subscriptionId,
          resourceGroupName: server.resourceGroup,
          name: server.functionAppName,
        });
        expect(settings.properties?.TANSTACK_ENV_MARKER).toBe("tanstack-start-azure-app-setting");

        // The server function ran on the Function: it read the app setting.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("TANSTACK_AWS_PAGE_MARKER"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        expect(home.body).toContain("env:tanstack-start-azure-app-setting");
        // The project's own vite.config.ts applied (its `define` marker).
        expect(home.body).toContain("config:tanstack-start-aws-user-config-loaded");

        // The server route runs on the Function: it echoes the query.
        const api = yield* waitForPage(
          `${url}/api/hello?echo=azure-roundtrip`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(api)).toBe(true);
        expect(api.body).toContain("TANSTACK_AWS_API_MARKER");
        expect(api.body).toContain("azure-roundtrip");

        // The client bundle is a Blob asset with an immutable cache header.
        const script = home.body.match(/(\/assets\/[^"']+\.js)/);
        expect(script).not.toBeNull();
        const asset = yield* waitForPage(
          `${url}${script![1]!}`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(asset)).toBe(true);
        expect(asset.headers["cache-control"]).toBe(assetCacheControl);
        const blob = yield* webBlob(site.storageAccount!.storageAccountName, script![1]!.slice(1));
        expect(blob?.cacheControl).toBe(assetCacheControl);

        // A public file comes from Blob Storage too.
        const robots = yield* fetchPage(`${url}/robots.txt`);
        expect(robots.status).toBe(200);
        expect(robots.body).toContain("tanstack-start-aws-robots-marker");

        // An unknown page is TanStack Start's 404, rendered by the Function.
        const missing = yield* fetchPage(`${url}/no-such-page`);
        expect(missing.status).toBe(404);

        const groupName = site.resourceGroup!.resourceGroupName;
        const profileGroup = site.frontDoor!.profile.resourceGroup;
        const profileName = site.frontDoor!.profile.profileName;
        yield* stack.destroy();
        expect(yield* getProfile(profileGroup, profileName)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: FRONT_DOOR_TIMEOUT },
  );
});
