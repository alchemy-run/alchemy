import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl, htmlCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertGroupGone,
  cloudflareFixture,
  fetchPage,
  FRONT_DOOR_TIMEOUT,
  frontDoorUrl,
  frontDoorWait,
  getEndpoint,
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

const fixtureDir = cloudflareFixture("vite-spa-fixture");
const fixtureEntries = ["index.html", "package.json", "src"];

describe("Azure.Website.Vite", { tags }, () => {
  // ~$0.10/run (Front Door Standard base fee by the hour, one Standard_LRS
  // account); 35-55 min: endpoint propagation, then the profile delete.
  test.provider(
    "Vite SPA behind Front Door: deploy, redeploy purges changed paths, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vite-azure-",
          tempRoot,
          entries: fixtureEntries,
        });
        const program = Effect.gen(function* () {
          return yield* Azure.Website.Vite("Web", {
            rootDir,
            location: LOCATION,
            memo: { include: ["index.html", "src/**", "package.json"] },
          });
        });

        const site = yield* stack.deploy(program);
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.server).toBeUndefined();
        expect(site.assets!.fileCount).toBeGreaterThan(1);
        expect(site.assets!.purgedPaths).toEqual([]);

        // Out of band: the account serves a static website and holds the files.
        const account = site.storageAccount!.storageAccountName;
        expect(yield* staticWebsiteEnabled(account)).toBe(true);
        const index = yield* webBlob(account, "index.html");
        expect(index?.contentType).toBe("text/html; charset=utf-8");
        expect(index?.cacheControl).toBe(htmlCacheControl);
        const frontDoor = site.frontDoor!;
        const endpoint = yield* getEndpoint(
          frontDoor.profile.resourceGroup,
          frontDoor.profile.profileName,
          frontDoor.endpoint.endpointName,
        );
        expect(endpoint?.properties?.hostName).toBe(new URL(url).hostname);

        // Through Front Door once the route has propagated.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("Vite SPA fixture"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        expect(home.headers["content-type"]).toContain("text/html");
        const script = home.body.match(/<script[^>]+src="([^"]+)"/);
        expect(script).not.toBeNull();
        const javascript = yield* waitForPage(
          new URL(script![1]!, `${url}/`).href,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(javascript)).toBe(true);
        expect(javascript.headers["content-type"]).toMatch(/javascript/);
        expect(javascript.headers["cache-control"]).toBe(assetCacheControl);
        // SPA deep link: Front Door rewrites it to the shell with a 200.
        const deepLink = yield* fetchPage(`${url}/missing-client-route`);
        expect(deepLink.status).toBe(200);
        expect(deepLink.body).toContain("Vite SPA fixture");

        // Change one file: the redeploy uploads it and purges its paths.
        const fs = yield* FileSystem.FileSystem;
        const indexPath = `${rootDir}/index.html`;
        const html = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(
          indexPath,
          html.replace("<body>", "<body><!-- AZURE_REDEPLOY -->"),
        );
        const updated = yield* stack.deploy(program);
        expect(updated.url).toBe(url);
        expect(updated.assets!.contentHash).not.toBe(site.assets!.contentHash);
        expect(updated.assets!.purgedPaths).toEqual(["/", "/index.html"]);
        const redeployed = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("AZURE_REDEPLOY"),
          frontDoorWait,
        );
        expect(viaFrontDoor(redeployed)).toBe(true);

        const groupName = site.resourceGroup!.resourceGroupName;
        const profileGroup = frontDoor.profile.resourceGroup;
        const profileName = frontDoor.profile.profileName;
        yield* stack.destroy();
        expect(yield* getProfile(profileGroup, profileName)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: FRONT_DOOR_TIMEOUT },
  );
});
