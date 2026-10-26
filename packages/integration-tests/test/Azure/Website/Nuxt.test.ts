import * as Azure from "@alchemy.run/azure";
import { orUndefinedIfNotFound } from "@alchemy.run/azure/Arm";
import * as web from "@distilled.cloud/azure/web";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
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
  tags,
  tempRoot,
  viaFrontDoor,
  waitForPage,
  webBlob,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/nuxt-app");
const fixtureEntries = [".gitignore", "package.json", "nuxt.config.ts", "app", "server", "public"];

const getFunctionApp = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(web.GetWebApp({ subscriptionId, resourceGroupName, name }));
  });

describe("Azure.Website.Nuxt", { tags }, () => {
  // ~$0.10/run (Front Door Standard by the hour, a Flex Consumption
  // Function, two Standard_LRS accounts); 35-55 min with the profile delete.
  // One stack, one Front Door profile: pages and `server/api` routes render
  // on the Function; `/_nuxt/*`, `public/` and prerendered routes come from
  // Blob Storage.
  test.provider(
    "Nuxt on a Function behind Front Door: SSR, server route, assets, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-azure-",
          tempRoot,
          entries: fixtureEntries,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Nuxt("Web", {
              rootDir,
              location: LOCATION,
              // An app setting on the Function, read by `runtimeConfig` at render time.
              env: { NUXT_PUBLIC_ENV_MARKER: "azure-function-env" },
              memo: {
                include: ["app/**", "server/**", "public/**", "package.json", "nuxt.config.ts"],
              },
            });
          }),
        );
        const url = site.url as string;
        expect(url).toMatch(frontDoorUrl);
        expect(site.assets!.fileCount).toBeGreaterThan(2);

        // Out of band: the Function app exists, and Blob Storage holds the
        // prerendered route and the `public/` files.
        const server = site.server!;
        const app = yield* getFunctionApp(server.resourceGroup, server.functionAppName);
        expect(app?.properties?.defaultHostName).toBe(server.defaultHostName);
        const account = site.storageAccount!.storageAccountName;
        const prerenderedBlob = yield* webBlob(account, "prerendered/index.html");
        expect(prerenderedBlob?.contentType).toBe("text/html; charset=utf-8");

        // The home page renders on the Function with its app settings.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("NUXT_AWS_PAGE_MARKER"),
          frontDoorWait,
        );
        expect(viaFrontDoor(home)).toBe(true);
        expect(home.body).toContain("config:nuxt-aws-user-config-loaded");
        expect(home.body).toContain("env:azure-function-env");

        // A nitro server route sees the method and the query string.
        const api = yield* waitForPage(
          `${url}/api/hello?echo=roundtrip`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(JSON.parse(api.body)).toEqual({
          marker: "NUXT_AWS_API_MARKER",
          method: "GET",
          echo: "roundtrip",
        });

        // Hashed client files come from Blob Storage with immutable caching.
        const script = home.body.match(/"(\/_nuxt\/[^"]+\.js)"/)?.[1];
        expect(script).toMatch(/^\/_nuxt\//);
        const javascript = yield* waitForPage(
          `${url}${script}`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(viaFrontDoor(javascript)).toBe(true);
        expect(javascript.headers["cache-control"]).toBe(assetCacheControl);
        expect(javascript.headers["content-type"]).toMatch(/javascript/);

        // `public/` files and prerendered routes come from Blob Storage too.
        const robots = yield* waitForPage(
          `${url}/robots.txt`,
          (page) => page.status === 200,
          frontDoorWait,
        );
        expect(robots.body).toContain("User-agent");
        const prerendered = yield* fetchPage(`${url}/prerendered/`);
        expect(prerendered.status).toBe(200);
        expect(prerendered.body).toContain("NUXT_AWS_PRERENDERED_MARKER");

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
