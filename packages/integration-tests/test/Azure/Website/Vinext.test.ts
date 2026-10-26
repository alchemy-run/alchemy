import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
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
  viaFrontDoor,
  waitForPage,
  webBlob,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Built in place: vinext and its RSC toolchain resolve only from the
// example's own node_modules (build output is gitignored there).
const rootDir = pathe.resolve(import.meta.dirname, "../../../../../examples/azure-website-vinext");

const memo = {
  include: ["app/**", "public/**", "package.json", "vite.config.ts", "tsconfig.json"],
};

describe("Azure.Website.Vinext", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  test.provider(
    "App Router on a Flex Consumption Function behind Front Door, assets on Blob Storage",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Vinext("Web", {
              rootDir,
              location: LOCATION,
              memo,
              env: { GREETING: "Hello from vinext on a Function!" },
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
        expect(settings.properties?.GREETING).toBe("Hello from vinext on a Function!");

        // The page is server-rendered by vinext's fetch handler on the Function.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("Hello from vinext on Azure!"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);

        // The route handler runs on the Function: it reads the app setting.
        const api = yield* waitForPage(
          `${url}/api/hello?name=Alchemy`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(api)).toBe(true);
        expect(JSON.parse(api.body)).toEqual({
          name: "Alchemy",
          greeting: "Hello from vinext on a Function!",
        });

        const isr = yield* fetchPage(`${url}/isr`);
        expect(isr.status).toBe(200);
        expect(isr.body).toContain("revalidate 60s");

        // The stylesheet is a Blob asset under /_next/static with an immutable cache header.
        const css = home.body.match(/href="(\/_next\/static\/[^"]+\.css)"/);
        expect(css).not.toBeNull();
        const asset = yield* waitForPage(
          `${url}${css![1]!}`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(asset)).toBe(true);
        expect(asset.headers["cache-control"]).toBe(assetCacheControl);
        expect(asset.body).toContain(".text-3xl");
        const blob = yield* webBlob(site.storageAccount!.storageAccountName, css![1]!.slice(1));
        expect(blob?.cacheControl).toBe(assetCacheControl);

        // A public file comes from Blob Storage too.
        const robots = yield* fetchPage(`${url}/robots.txt`);
        expect(robots.status).toBe(200);
        expect(robots.body).toContain("User-agent:");

        // An unknown page is vinext's 404, rendered by the Function.
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
