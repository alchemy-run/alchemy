import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Namespace from "alchemy/Namespace";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import {
  assertGroupGone,
  fetchPage,
  fixture,
  FRONT_DOOR_TIMEOUT,
  frontDoorUrl,
  frontDoorWait,
  getProfile,
  LOCATION,
  logLevel,
  tags,
  viaFrontDoor,
  waitForPage,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

const root = fixture("ssr-site");

/**
 * The server-build path every SSR framework composite uses: a Fetch handler
 * on a Flex Consumption Function behind Front Door, with the client
 * directory's top-level paths on Blob Storage. The fixture stands in for a
 * framework's Azure target output.
 */
const program = Azure.Website.deploySite({
  site: { location: LOCATION, env: { GREETING: "hello" } },
  framework: "fixture",
  clientDir: `${root}/client`,
  serverEntry: `${root}/server.ts`,
  assetPatterns: ["/assets/*", "/robots.txt"],
  spa: false,
  errorPage: undefined,
}).pipe(Namespace.push("Site"), Effect.orDie);

describe("Azure.Website server builds", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  test.provider(
    "Front Door routes pages to the Function and assets to Blob Storage",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const site = yield* stack.deploy(program);
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.server!.functionAppName.length).toBeGreaterThan(0);
        expect(site.assets!.fileCount).toBe(2);

        // A page runs on the Function, which sees the Front Door host.
        const page = yield* waitForPage(
          `${url}/products/42`,
          (page) => page.status === 200 && page.headers["x-rendered-by"] === "azure-function",
          frontDoorWait,
        );
        expect(viaFrontDoor(page)).toBe(true);
        expect(page.body).toBe(`<h1>rendered /products/42 for ${new URL(url).host}</h1>`);

        // Assets come from Blob Storage with their cache headers.
        const script = yield* waitForPage(
          `${url}/assets/app.js`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(script)).toBe(true);
        expect(script.headers["x-rendered-by"]).toBeUndefined();
        expect(script.headers["cache-control"]).toBe(assetCacheControl);
        expect(script.body).toContain("ssr fixture asset");
        const robots = yield* fetchPage(`${url}/robots.txt`);
        expect(robots.status).toBe(200);
        expect(robots.headers["x-rendered-by"]).toBeUndefined();

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
