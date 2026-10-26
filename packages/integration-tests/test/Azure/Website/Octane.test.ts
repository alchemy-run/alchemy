import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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

describe("Azure.Website.Octane", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  test.provider(
    "SSR on a Flex Consumption Function behind Front Door, assets on Blob Storage",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-octane-azure-",
          tempRoot,
          entries: fixtureEntries,
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configPath = path.join(rootDir, "octane.config.ts");
        const config = yield* fs.readFileString(configPath);
        expect(config).not.toContain("adapter:");

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Octane("Web", {
              rootDir,
              location: LOCATION,
              memo: {
                include: [
                  "src/**",
                  "public/**",
                  "package.json",
                  "octane.config.ts",
                  "vite.config.ts",
                  "index.html",
                ],
              },
            });
          }),
        );
        // The build leaves the project's config untouched.
        expect(yield* fs.readFileString(configPath)).toBe(config);
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.server!.functionAppName.length).toBeGreaterThan(0);
        expect(site.frontDoor!.endpoint.endpointName.length).toBeGreaterThan(0);

        // The SSR page is rendered by the Function, through Front Door.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("OCTANE_AWS_PAGE_MARKER"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        expect(home.headers["content-type"]).toContain("text/html");
        // The inlined SSR template rendered: the shell's markers are filled.
        expect(home.body).toContain("<title>Octane AWS fixture</title>");
        expect(home.body).not.toContain("<!--ssr-body-->");

        // The server route runs on the Function: it echoes the query.
        const api = yield* waitForPage(
          `${url}/api/hello?echo=azure-roundtrip`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(api)).toBe(true);
        expect(JSON.parse(api.body)).toEqual({
          marker: "OCTANE_AWS_API_MARKER",
          echo: "azure-roundtrip",
        });

        // The hydration script is a Blob asset with an immutable cache header.
        const script = home.body.match(/href="(\/assets\/[^"]+\.js)"/);
        expect(script).not.toBeNull();
        const asset = yield* waitForPage(
          `${url}${script![1]!}`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(asset)).toBe(true);
        expect(asset.headers["cache-control"]).toBe(assetCacheControl);
        const account = site.storageAccount!.storageAccountName;
        const blob = yield* webBlob(account, script![1]!.slice(1));
        expect(blob?.cacheControl).toBe(assetCacheControl);

        // A public file comes from Blob Storage too.
        const robots = yield* fetchPage(`${url}/robots.txt`);
        expect(robots.status).toBe(200);
        expect(robots.body).toContain("octane-aws-robots-marker");

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
