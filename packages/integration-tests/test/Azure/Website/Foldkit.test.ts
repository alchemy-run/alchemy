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
import { runPaidOnly } from "../gates.ts";
import {
  appServiceUrl,
  assertGroupGone,
  fetchPage,
  APP_SERVICE_LOCATION,
  LOCATION,
  logLevel,
  staticWebsiteEnabled,
  storageWebUrl,
  tags,
  waitForPage,
  webAppConfig,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

describe("Azure.Website.Foldkit", { tags }, () => {
  // Browser-only and prerendered builds go to a storage static website:
  // no Docker image, no server. One stack walks SPA → static.
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
              memo: foldkitMemo,
            });
          }),
        );
        const url = spa.url as string;
        expect(url).toMatch(storageWebUrl);
        expect(spa.assets).toBeDefined();
        expect(spa.app).toBeUndefined();
        expect(
          yield* staticWebsiteEnabled(
            spa.storageAccount!.resourceGroup,
            spa.storageAccount!.storageAccountName,
          ),
        ).toBe(true);

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

  // A server build runs Foldkit's fetch handler on a Linux App Service web
  // app (Node.js runtime, zip deploy). B1 plan: ~$0.02 for one run. New
  // plans in eastus fail with "Cannot acquire exclusive lock to create or
  // update this server farm"; the Web suites use westus3.
  test.provider(
    "SSR build on an App Service web app",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* foldkitFixture("ssr");
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Foldkit("Web", {
              rootDir,
              location: APP_SERVICE_LOCATION,
              output: "server",
              memo: foldkitMemo,
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(appServiceUrl);
        expect(site.assets).toBeUndefined();
        const config = yield* webAppConfig(site.app!.resourceGroup, site.app!.siteName);
        expect(config.linuxFxVersion).toBe(Azure.Website.DEFAULT_NODE_STACK);
        expect(config.appCommandLine).toMatch(/^node .*index\.mjs$/);

        yield* verifyFoldkitRendering(url, "ssr");
        yield* verifyFoldkitBrowser(url, "ssr");

        const groupName = site.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 1_200_000 },
  );

  // Front Door Standard bills ~$35/month plus traffic and its endpoints take
  // 10-20 minutes to propagate, so this runs only with AZURE_TEST_PAID=1.
  // Front Door's rewrite rule answers SPA deep links with a 200. The title
  // stays short: Front Door rejects resource group names over 80 characters.
  test.provider.skipIf(!runPaidOnly)(
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
              frontDoor: true,
              memo: foldkitMemo,
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(/^https:\/\/.+\.azurefd\.net$/);
        expect(site.frontDoor).toBeDefined();
        // A new endpoint answers Front Door's own 404 until the route
        // propagates (10-20 minutes); wait for the shell first.
        yield* waitForPage(`${url}/`, (page) => page.body.includes("Foldkit Fixture"), {
          spacing: "30 seconds",
          times: 50,
        });
        const deepLink = yield* fetchPage(`${url}/counter/42`);
        expect(deepLink.status).toBe(200);
        expect(deepLink.body).toContain("Foldkit Fixture");
        yield* verifyFoldkitRendering(url, "spa");

        const groupName = site.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 3_600_000 },
  );
});
