import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertGroupGone,
  fetchPage,
  fixture,
  getStorageAccount,
  LOCATION,
  logLevel,
  staticWebsiteEnabled,
  storageWebUrl,
  tags,
  tempRoot,
  waitForPage,
  webBlob,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

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
        const docsPath = `${cwd}/src/docs/index.html`;
        const html = yield* fs.readFileString(docsPath);
        yield* fs.writeFileString(
          docsPath,
          html.replace("<body>", "<body><!-- AZURE_REDEPLOY -->"),
        );
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
});
