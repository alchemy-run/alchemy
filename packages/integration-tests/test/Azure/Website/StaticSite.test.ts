import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl, htmlCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertGroupGone,
  fetchPage,
  fixture,
  FRONT_DOOR_TIMEOUT,
  frontDoorUrl,
  frontDoorWait,
  getEndpoint,
  getProfile,
  getStorageAccount,
  LOCATION,
  logLevel,
  staticWebsiteEnabled,
  storageWebUrl,
  tags,
  tempRoot,
  viaFrontDoor,
  waitForPage,
  webBlob,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Mark the `<body>` of an HTML file so a redeploy changes it. */
const markHtml = (file: string, marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const html = yield* fs.readFileString(file);
    yield* fs.writeFileString(file, html.replace("<body>", `<body><!-- ${marker} -->`));
  });

describe("Azure.Website.StaticSite", { tags }, () => {
  // ~$0.01/run (one Standard_LRS account, a few KB); ~4 min.
  test.provider(
    "static site without Front Door: deploy, redeploy deletes removed files, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixture("static-site"), {
          prefix: "alchemy-static-site-azure-",
          tempRoot,
        });
        const program = Effect.gen(function* () {
          return yield* Azure.Website.StaticSite("Site", {
            cwd,
            command: "node build.mjs",
            outdir: "public",
            errorPage: "404.html",
            location: LOCATION,
            frontDoor: false,
          });
        });

        const site = yield* stack.deploy(program);
        const url = site.url as string;
        expect(url).toMatch(storageWebUrl);
        expect(site.frontDoor).toBeUndefined();
        expect(site.server).toBeUndefined();
        expect(site.assets!.fileCount).toBe(4);
        expect(site.assets!.purgedPaths).toEqual([]);

        // Out of band: the endpoint is on and nested names keep their path.
        const account = site.storageAccount!.storageAccountName;
        expect(yield* staticWebsiteEnabled(account)).toBe(true);
        const docs = yield* webBlob(account, "docs/index.html");
        expect(docs?.contentType).toBe("text/html; charset=utf-8");
        const script = yield* webBlob(account, "assets/app.js");
        expect(script?.cacheControl).toBe(assetCacheControl);

        const home = yield* waitForPage(`${url}/`, (page) => page.status === 200);
        expect(home.body).toContain("Azure static site fixture");
        const docsPage = yield* fetchPage(`${url}/docs/`);
        expect(docsPage.status).toBe(200);
        expect(docsPage.body).toContain("Static site fixture docs");
        const javascript = yield* fetchPage(`${url}/assets/app.js`);
        expect(javascript.status).toBe(200);
        expect(javascript.headers["content-type"]).toMatch(/javascript/);
        const missing = yield* fetchPage(`${url}/no-such-page`);
        expect(missing.status).toBe(404);
        expect(missing.body).toContain("page not found");

        // Remove one file and change another: the redeploy syncs both.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${cwd}/src/assets/app.js`);
        yield* markHtml(`${cwd}/src/docs/index.html`, "AZURE_REDEPLOY");
        const updated = yield* stack.deploy(program);
        expect(updated.url).toBe(url);
        expect(updated.assets!.fileCount).toBe(3);
        expect(updated.assets!.contentHash).not.toBe(site.assets!.contentHash);
        expect(yield* webBlob(account, "assets/app.js")).toBeUndefined();
        yield* waitForPage(`${url}/docs/`, (page) => page.body.includes("AZURE_REDEPLOY"));

        const groupName = site.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        expect(yield* getStorageAccount(groupName, account)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );

  // ~$0.10/run (one Front Door Standard profile by the hour, two
  // Standard_LRS accounts); 35-55 min: endpoint propagation, then the
  // profile delete. "App" creates the profile (Front Door is the default)
  // and "Docs" adds its endpoint to the same profile. The title stays
  // short: the stack's resource group name is capped at 80 characters.
  test.provider(
    "Front Door: SPA, 404 page, purge",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const clone = (prefix: string) =>
          cloneFixture(fixture("static-site"), { prefix, tempRoot, entries: ["build.mjs", "src"] });
        const appCwd = yield* clone("alchemy-static-site-azure-app-");
        const docsCwd = yield* clone("alchemy-static-site-azure-docs-");
        const program = Effect.gen(function* () {
          const app = yield* Azure.Website.StaticSite("App", {
            cwd: appCwd,
            command: "node build.mjs",
            outdir: "public",
            spa: true,
            location: LOCATION,
          });
          const docs = yield* Azure.Website.StaticSite("Docs", {
            cwd: docsCwd,
            command: "node build.mjs",
            outdir: "public",
            errorPage: "404.html",
            location: LOCATION,
            frontDoor: { profile: app.frontDoor!.profile },
          });
          return { app, docs };
        });

        const { app, docs } = yield* stack.deploy(program);
        const appUrl = app.url as string;
        const docsUrl = docs.url as string;
        expect(appUrl).toMatch(frontDoorUrl);
        expect(docsUrl).toMatch(frontDoorUrl);
        expect(docsUrl).not.toBe(appUrl);
        expect(app.server).toBeUndefined();
        expect(app.assets!.fileCount).toBe(4);
        expect(app.assets!.purgedPaths).toEqual([]);

        // Out of band: one Standard profile holds both endpoints.
        const profile = app.frontDoor!.profile;
        expect(docs.frontDoor!.profile.profileName).toBe(profile.profileName);
        const observedProfile = yield* getProfile(profile.resourceGroup, profile.profileName);
        expect(observedProfile?.sku?.name).toBe("Standard_AzureFrontDoor");
        for (const site of [app, docs]) {
          const endpoint = yield* getEndpoint(
            profile.resourceGroup,
            profile.profileName,
            site.frontDoor!.endpoint.endpointName,
          );
          expect(endpoint?.properties?.hostName).toBe(new URL(site.url as string).hostname);
        }
        const appAccount = app.storageAccount!.storageAccountName;
        expect(yield* staticWebsiteEnabled(appAccount)).toBe(true);
        expect((yield* webBlob(appAccount, "index.html"))?.cacheControl).toBe(htmlCacheControl);

        // The SPA through Front Door: files, then a deep link rewritten to the shell.
        const home = yield* waitForPage(
          `${appUrl}/`,
          (page) => page.status === 200 && page.body.includes("Azure static site fixture"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        const script = yield* waitForPage(
          `${appUrl}/assets/app.js`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(script)).toBe(true);
        expect(script.headers["content-type"]).toMatch(/javascript/);
        expect(script.headers["cache-control"]).toBe(assetCacheControl);
        const deepLink = yield* fetchPage(`${appUrl}/client/route`);
        expect(deepLink.status).toBe(200);
        expect(deepLink.body).toContain("Azure static site fixture");

        // The multi-page site through Front Door: a nested index and a real 404.
        const docsPage = yield* waitForPage(
          `${docsUrl}/docs/`,
          (page) => page.status === 200 && page.body.includes("Static site fixture docs"),
          frontDoorWait,
        );
        expect(viaFrontDoor(docsPage)).toBe(true);
        const missing = yield* fetchPage(`${docsUrl}/no-such-page`);
        expect(missing.status).toBe(404);
        expect(viaFrontDoor(missing)).toBe(true);
        expect(missing.body).toContain("page not found");
        // Cache the asset at the edge (immutable for a year) so only the purge removes it.
        const cachedAsset = yield* fetchPage(`${docsUrl}/assets/app.js`);
        expect(cachedAsset.status).toBe(200);

        // Redeploy: each site purges exactly the paths it replaced or deleted.
        const fs = yield* FileSystem.FileSystem;
        yield* markHtml(`${appCwd}/src/index.html`, "AZURE_APP_REDEPLOY");
        yield* fs.remove(`${docsCwd}/src/assets/app.js`);
        yield* markHtml(`${docsCwd}/src/docs/index.html`, "AZURE_DOCS_REDEPLOY");
        const updated = yield* stack.deploy(program);
        expect(updated.app.url).toBe(appUrl);
        expect(updated.docs.url).toBe(docsUrl);
        expect(updated.app.assets!.purgedPaths).toEqual(["/", "/index.html"]);
        expect(updated.docs.assets!.purgedPaths).toEqual([
          "/assets/app.js",
          "/docs",
          "/docs/",
          "/docs/index.html",
        ]);
        expect(updated.docs.assets!.fileCount).toBe(3);
        const redeployed = yield* waitForPage(
          `${appUrl}/`,
          (page) => page.body.includes("AZURE_APP_REDEPLOY"),
          frontDoorWait,
        );
        expect(viaFrontDoor(redeployed)).toBe(true);
        yield* waitForPage(
          `${docsUrl}/docs/`,
          (page) => page.body.includes("AZURE_DOCS_REDEPLOY"),
          frontDoorWait,
        );
        const removed = yield* waitForPage(
          `${docsUrl}/assets/app.js`,
          (page) => page.status === 404,
          frontDoorWait,
        );
        expect(removed.body).toContain("page not found");

        const groupName = app.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        expect(yield* getProfile(profile.resourceGroup, profile.profileName)).toBeUndefined();
        expect(yield* getStorageAccount(groupName, appAccount)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: FRONT_DOOR_TIMEOUT },
  );
});
