import * as Azure from "@alchemy.run/azure";
import { orUndefinedIfNotFound } from "@alchemy.run/azure/Arm";
import * as web from "@distilled.cloud/azure/web";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { prepareNextjsFixture } from "../../Cloudflare/Website/TypeScriptCompat.ts";
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

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/nextjs-app");
const azurePackageDir = pathe.resolve(import.meta.dirname, "../../../../azure");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
  "public",
];

const getFunctionApp = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(web.GetWebApp({ subscriptionId, resourceGroupName, name }));
  });

describe("Azure.Website.Nextjs", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  // One stack, one Front Door profile: pages, route handlers and
  // `/_next/image` run on the Function; `/_next/static` and `public/` come
  // from Blob Storage.
  test.provider(
    "Next.js on a Function behind Front Door: SSR, route handler, assets, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
        // Next treat the alchemy monorepo as the workspace root.
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-azure-",
          entries: fixtureEntries,
        });
        yield* prepareNextjsFixture(rootDir);
        // Like a real app, the project depends on the provider package: the
        // Function's generated entry imports its bootstrap from there.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${rootDir}/node_modules/@alchemy.run`, { recursive: true });
        yield* fs.symlink(azurePackageDir, `${rootDir}/node_modules/@alchemy.run/azure`);

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Nextjs("Web", {
              rootDir,
              location: LOCATION,
              memo: {
                include: ["app/**", "public/**", "package.json", "next.config.ts", "tsconfig.json"],
              },
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        // `public/` (pixel.png, robots.txt) plus the hashed `_next/static` files.
        expect(site.assets!.fileCount).toBeGreaterThan(2);

        // Out of band: the Function app exists, and Blob Storage holds `public/` files.
        const server = site.server!;
        const app = yield* getFunctionApp(server.resourceGroup, server.functionAppName);
        expect(app?.properties?.defaultHostName).toBe(server.defaultHostName);
        const account = site.storageAccount!.storageAccountName;
        const pixel = yield* webBlob(account, "pixel.png");
        expect(pixel?.contentType).toBe("image/png");

        // A dynamic page renders on the Function on every request.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("NEXTJS_AWS_PAGE_MARKER"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        expect(home.headers["x-powered-by"]).toBe("Next.js");
        const renderedAt = (page: { body: string }) =>
          page.body.match(/rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
        expect(renderedAt(home)).toMatch(/^\d+$/);
        const again = yield* fetchPage(`${url}/`);
        expect(again.status).toBe(200);
        expect(renderedAt(again)).not.toBe(renderedAt(home));

        // An App Router route handler sees the query string.
        const api = yield* waitForPage(
          `${url}/api/hello?echo=roundtrip`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(JSON.parse(api.body)).toEqual({
          marker: "NEXTJS_AWS_API_MARKER",
          echo: "roundtrip",
        });

        // A prerendered page is served by Next from the standalone build.
        const prerendered = yield* fetchPage(`${url}/static`);
        expect(prerendered.status).toBe(200);
        expect(prerendered.headers["x-powered-by"]).toBe("Next.js");
        expect(prerendered.body).toContain("NEXTJS_AWS_STATIC_MARKER");

        // Hashed build files come from Blob Storage with immutable caching.
        const script = home.body.match(/src="(\/_next\/static\/[^"]+\.js)"/)?.[1];
        expect(script).toMatch(/^\/_next\/static\//);
        const javascript = yield* waitForPage(
          `${url}${script}`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(javascript)).toBe(true);
        expect(javascript.headers["x-powered-by"]).toBeUndefined();
        expect(javascript.headers["cache-control"]).toBe(assetCacheControl);
        expect(javascript.headers["content-type"]).toMatch(/javascript/);

        // `public/` files come from Blob Storage too.
        const robots = yield* waitForPage(
          `${url}/robots.txt`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(robots.headers["x-powered-by"]).toBeUndefined();
        expect(robots.body).toContain("User-agent");

        // `/_next/image` is not an asset: the Function's image optimizer answers it.
        const image = yield* waitForPage(
          `${url}/_next/image?url=%2Fpixel.png&w=64&q=75`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(image.headers["content-type"]).toMatch(/^image\//);

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
