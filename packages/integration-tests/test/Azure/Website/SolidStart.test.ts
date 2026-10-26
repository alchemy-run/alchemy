import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl, htmlCacheControl } from "alchemy/Website/assets";
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
  staticWebsiteEnabled,
  tags,
  tempRoot,
  viaFrontDoor,
  waitForPage,
  webBlob,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/solidstart-app");
const fixtureEntries = [".gitignore", "package.json", "vite.config.ts", "src", "public"];

/** An app setting only the Function has; the home page renders it. */
const ENV_MARKER = "solidstart-azure-function-env";

describe("Azure.Website.SolidStart", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  test.provider(
    "nitro SSR on a Function and .output/public on Blob Storage behind Front Door",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-solidstart-azure-",
          tempRoot,
          entries: fixtureEntries,
        });
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.SolidStart("Web", {
              rootDir,
              location: LOCATION,
              memo: { include: ["src/**", "public/**", "package.json", "vite.config.ts"] },
              env: { SOLIDSTART_ENV_MARKER: ENV_MARKER },
              // Forwarded into the nitro plugin the integration appends.
              nitro: { prerender: { routes: ["/prerendered"] } },
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.server!.functionAppName.length).toBeGreaterThan(0);

        // Out of band: `.output/public` (prerendered page included) is in `$web`.
        const account = site.storageAccount!.storageAccountName;
        expect(yield* staticWebsiteEnabled(account)).toBe(true);
        const prerenderedBlob = yield* webBlob(account, "prerendered/index.html");
        expect(prerenderedBlob?.contentType).toBe("text/html; charset=utf-8");
        expect(prerenderedBlob?.cacheControl).toBe(htmlCacheControl);

        // The home page renders on the Function: it reads the Function's app setting.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("SOLIDSTART_AWS_PAGE_MARKER"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        expect(home.body).toContain(`env:${ENV_MARKER}`);
        // The fixture's own vite.config.ts applied (its `define` marker).
        expect(home.body).toContain("config:solidstart-aws-user-config-loaded");

        // An API route runs on the Function: it echoes the query.
        const api = yield* waitForPage(
          `${url}/api/hello?echo=azure-roundtrip`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(api)).toBe(true);
        expect(api.body).toBe("SOLIDSTART_AWS_API_MARKER:azure-roundtrip");

        // Hashed client assets come from Blob Storage with their cache header.
        const script = home.body.match(/\/_build\/assets\/[^"']+\.js/);
        expect(script).not.toBeNull();
        const javascript = yield* waitForPage(
          `${url}${script![0]}`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(javascript)).toBe(true);
        expect(javascript.headers["cache-control"]).toBe(assetCacheControl);

        // The prerendered page: Blob Storage under its directory, and SSR
        // on the Function at the bare route.
        const prerenderedFile = yield* waitForPage(
          `${url}/prerendered/`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(prerenderedFile.body).toContain("SOLIDSTART_AWS_PRERENDERED_MARKER");
        expect(prerenderedFile.headers["cache-control"]).toBe(htmlCacheControl);
        const prerendered = yield* waitForPage(
          `${url}/prerendered`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(prerendered.body).toContain("SOLIDSTART_AWS_PRERENDERED_MARKER");

        // A `public/` file comes from Blob Storage.
        const robots = yield* fetchPage(`${url}/robots.txt`);
        expect(robots.status).toBe(200);
        expect(robots.body).toContain("solidstart-aws-robots-marker");
        expect(robots.headers["cache-control"]).toBe(assetCacheControl);

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
