import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import {
  foldkitFixture,
  foldkitMemo,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/Foldkit.ts";
import { runExpensive } from "../gates.ts";
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
  storageWebUrl,
  tags,
  viaFrontDoor,
  waitForPage,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

describe("Azure.Website.Foldkit", { tags }, () => {
  // ~$0.01/run (one Standard_LRS account); ~5 min. Browser-only and
  // prerendered builds without Front Door go to a storage static website:
  // no server. One stack walks SPA → static.
  test.provider(
    "SPA and prerendered builds on a storage static website",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const spaRoot = yield* foldkitFixture("spa");
        const spa = yield* stack.deploy(
          Effect.gen(function* () {
            // Deliberately no `output` or `assets`: the SPA default is under test.
            return yield* Azure.Website.Foldkit("Web", {
              rootDir: spaRoot,
              location: LOCATION,
              frontDoor: false,
              memo: foldkitMemo,
            });
          }),
        );
        const url = spa.url as string;
        expect(url).toMatch(storageWebUrl);
        expect(spa.assets!.fileCount).toBeGreaterThan(1);
        expect(spa.server).toBeUndefined();
        expect(spa.frontDoor).toBeUndefined();
        expect(yield* staticWebsiteEnabled(spa.storageAccount!.storageAccountName)).toBe(true);

        const root = yield* waitForPage(`${url}/`, (page) => page.status === 200);
        expect(root.body).toContain("Foldkit Fixture");
        const probe = yield* fetchPage(`${url}/foldkit-probe.txt`);
        expect(probe.status).toBe(200);
        expect(probe.body).toBe("FOLDKIT_STATIC_ASSET");
        // The storage endpoint answers a deep link with the app shell and a 404.
        const deepLink = yield* fetchPage(`${url}/counter/42`);
        expect(deepLink.status).toBe(404);
        expect(deepLink.body).toContain("Foldkit Fixture");

        // Same stack, prerendered output: the upload replaces the SPA files
        // and the 404 fallback goes away.
        const staticRoot = yield* foldkitFixture("static");
        const prerendered = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Foldkit("Web", {
              rootDir: staticRoot,
              location: LOCATION,
              output: "static",
              frontDoor: false,
              memo: foldkitMemo,
            });
          }),
        );
        expect(prerendered.url).toBe(url);
        yield* verifyFoldkitRendering(url, "static");
        yield* verifyFoldkitBrowser(url, "static");

        const groupName = prerendered.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );

  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  // A server build runs Foldkit's fetch handler on the Function; Front Door
  // sends pages to it and the client assets to Blob Storage.
  test.provider.skipIf(!runExpensive)(
    "SSR build on a Function behind Front Door",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* foldkitFixture("ssr");
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Foldkit("Web", {
              rootDir,
              location: LOCATION,
              output: "server",
              memo: foldkitMemo,
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.server!.functionAppName.length).toBeGreaterThan(0);

        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("Foldkit"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        yield* verifyFoldkitRendering(url, "ssr");
        yield* verifyFoldkitBrowser(url, "ssr");

        const groupName = site.resourceGroup!.resourceGroupName;
        const profileGroup = site.frontDoor!.profile.resourceGroup;
        const profileName = site.frontDoor!.profile.profileName;
        yield* stack.destroy();
        expect(yield* getProfile(profileGroup, profileName)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: FRONT_DOOR_TIMEOUT },
  );

  // ~$0.10/run (Front Door Standard by the hour, one Standard_LRS account);
  // 35-55 min with the profile delete. Front Door (the default) rewrites
  // SPA deep links to the shell with a 200. The title stays short: Front
  // Door rejects resource group names over 80 characters.
  test.provider.skipIf(!runExpensive)(
    "Front Door SPA",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* foldkitFixture("spa");
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Foldkit("Web", {
              rootDir,
              location: LOCATION,
              memo: foldkitMemo,
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.server).toBeUndefined();
        yield* waitForPage(`${url}/`, (page) => page.body.includes("Foldkit Fixture"), frontDoorWait);
        const deepLink = yield* fetchPage(`${url}/counter/42`);
        expect(deepLink.status).toBe(200);
        expect(deepLink.body).toContain("Foldkit Fixture");
        yield* verifyFoldkitRendering(url, "spa");

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
