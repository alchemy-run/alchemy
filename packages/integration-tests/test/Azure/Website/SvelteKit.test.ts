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

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/sveltekit-app");
const fixtureEntries = [".gitignore", "package.json", "src", "static"];

describe("Azure.Website.SvelteKit", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  test.provider(
    "kit SSR on a Function and prerendered pages on Blob Storage behind Front Door",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-sveltekit-azure-",
          tempRoot,
          entries: fixtureEntries,
        });
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.SvelteKit("Web", {
              rootDir,
              location: LOCATION,
              memo: { include: ["src/**", "static/**", "package.json"] },
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.server!.functionAppName.length).toBeGreaterThan(0);

        // Out of band: the client directory (prerendered page included) is in `$web`.
        const account = site.storageAccount!.storageAccountName;
        expect(yield* staticWebsiteEnabled(account)).toBe(true);
        const prerenderedBlob = yield* webBlob(account, "prerendered.html");
        expect(prerenderedBlob?.contentType).toBe("text/html; charset=utf-8");
        expect(prerenderedBlob?.cacheControl).toBe(htmlCacheControl);
        expect((yield* webBlob(account, "robots.txt"))?.contentType).toContain("text/plain");

        // A server `load` renders the home page on the Function, through Front Door.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("SVELTEKIT_AWS_PAGE_MARKER"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        expect(home.headers["content-type"]).toContain("text/html");

        // A `+server.ts` endpoint runs on the Function: it echoes the query.
        const api = yield* waitForPage(
          `${url}/api/hello?echo=azure-roundtrip`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(api)).toBe(true);
        expect(JSON.parse(api.body)).toEqual({
          marker: "SVELTEKIT_AWS_API_MARKER",
          echo: "azure-roundtrip",
        });

        // Kit's hashed client assets come from Blob Storage with their cache header.
        const script = home.body.match(/\/_app\/immutable\/[^"']+\.js/);
        expect(script).not.toBeNull();
        const javascript = yield* waitForPage(
          `${url}${script![0]}`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(javascript)).toBe(true);
        expect(javascript.headers["cache-control"]).toBe(assetCacheControl);

        // The prerendered page: Blob Storage at its file path, and at its
        // route through the Function, which fetches the same file.
        const prerenderedFile = yield* waitForPage(
          `${url}/prerendered.html`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(prerenderedFile.body).toContain("SVELTEKIT_AWS_PRERENDERED_MARKER");
        expect(prerenderedFile.headers["cache-control"]).toBe(htmlCacheControl);
        const prerendered = yield* waitForPage(
          `${url}/prerendered`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(prerendered)).toBe(true);
        expect(prerendered.body).toBe(prerenderedFile.body);
        expect(prerendered.headers["cache-control"]).toBe(htmlCacheControl);

        // A `static/` file comes from Blob Storage.
        const robots = yield* fetchPage(`${url}/robots.txt`);
        expect(robots.status).toBe(200);
        expect(robots.body).toContain("User-agent: *");
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
