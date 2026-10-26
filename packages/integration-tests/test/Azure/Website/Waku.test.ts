import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import {
  assertGroupGone,
  fetchPage,
  fixture,
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

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const GREETING = "Hello from Waku on Azure Functions";

const Stack = Alchemy.Stack(
  "AzureWebsiteWaku",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Waku("Web", {
      rootDir: fixture("waku-app"),
      location: LOCATION,
      env: { GREETING },
      memo: { include: ["src/**", "public/**", "package.json"] },
    });
    return {
      url: site.url,
      groupName: site.resourceGroup?.resourceGroupName,
      account: site.storageAccount?.storageAccountName,
      functionAppName: site.server?.functionAppName,
      profileGroup: site.frontDoor?.profile.resourceGroup,
      profileName: site.frontDoor?.profile.profileName,
    };
  }),
);

// ~$0.10/run (Front Door Standard by the hour, a Flex Consumption Function,
// two Standard_LRS accounts); ~3 min deploy, 10-20 min route propagation,
// 15-30 min profile delete. Run with `timeout 3600`.
const stack = beforeAll(deploy(Stack).pipe(logLevel), { timeout: 900_000 });

/** Azure credentials and environment for the out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

/** The stack outputs, with the deployed URL narrowed to a string. */
const site = Effect.map(stack, (out) => ({ ...out, url: String(out.url) }));

describe("Azure.Website.Waku", { tags }, () => {
  test(
    "Front Door sends a dynamic page to the server Function",
    Effect.gen(function* () {
      const { url, functionAppName } = yield* site;
      expect(url).toMatch(frontDoorUrl);
      expect(functionAppName!.length).toBeGreaterThan(0);

      // `getEnv("GREETING")` reads the Function's app setting at request time.
      const home = yield* waitForPage(
        `${url}/`,
        (page) => page.status === 200 && page.body.includes(GREETING),
        frontDoorWait,
      );
      expect(viaFrontDoor(home)).toBe(true);
      expect(home.body).toContain("WAKU_AZURE_PAGE_MARKER");
    }),
    { timeout: 1_800_000 },
  );

  test(
    "an API route runs on the Function and sees the Front Door host",
    Effect.gen(function* () {
      const { url } = yield* site;
      const echo = yield* waitForPage(
        `${url}/echo?echo=roundtrip`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(viaFrontDoor(echo)).toBe(true);
      expect(echo.headers["x-rendered-by"]).toBe("waku-function");
      expect(JSON.parse(echo.body)).toEqual({
        marker: "WAKU_AZURE_API_MARKER",
        echo: "roundtrip",
        host: new URL(url).host,
      });
    }),
    { timeout: 1_800_000 },
  );

  test(
    "the Function answers prerendered pages and every RSC payload",
    Effect.gen(function* () {
      const { url, account } = yield* site;
      const about = yield* waitForPage(
        `${url}/about`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(about.body).toContain("WAKU_AZURE_STATIC_MARKER");

      // The dynamic page's RSC payload exists only on the server.
      const rsc = yield* waitForPage(
        `${url}/RSC/R/_root.txt`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(rsc.body).toContain(GREETING);
      const prerenderedRsc = yield* fetchPage(`${url}/RSC/R/about.txt`);
      expect(prerenderedRsc.status).toBe(200);
      expect(prerenderedRsc.body).toContain("WAKU_AZURE_STATIC_MARKER");

      // Out of band: the prerendered HTML is on Blob Storage, the RSC payloads are not.
      const html = yield* webBlob(account!, "about/index.html").pipe(Effect.provide(azure));
      expect(html?.contentType).toBe("text/html; charset=utf-8");
      const payload = yield* webBlob(account!, "RSC/R/about.txt").pipe(Effect.provide(azure));
      expect(payload).toBeUndefined();
    }),
    { timeout: 1_800_000 },
  );

  test(
    "public files and hashed assets come from Blob Storage",
    Effect.gen(function* () {
      const { url } = yield* site;
      const robots = yield* waitForPage(
        `${url}/robots.txt`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(viaFrontDoor(robots)).toBe(true);
      expect(robots.body).toContain("waku-azure-robots-marker");

      const home = yield* fetchPage(`${url}/`);
      const script = /href="(\/assets\/[^"]+\.js)"/.exec(home.body)?.[1];
      expect(script).toMatch(/^\/assets\/.+\.js$/);
      const asset = yield* fetchPage(`${url}${script}`);
      expect(asset.status).toBe(200);
      expect(asset.headers["cache-control"]).toBe(assetCacheControl);
      expect(asset.headers["x-rendered-by"]).toBeUndefined();
    }),
    { timeout: 1_800_000 },
  );
});

// Destroy, then prove the Front Door profile and the site's resource group are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { groupName, profileGroup, profileName } = yield* stack;
    yield* destroy(Stack);
    expect(yield* getProfile(profileGroup!, profileName!)).toBeUndefined();
    yield* assertGroupGone(groupName!);
  }).pipe(Effect.provide(azure), logLevel),
  { timeout: 2_400_000 },
);
