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

const Stack = Alchemy.Stack(
  "AzureWebsiteVocs",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Vocs("Docs", {
      rootDir: fixture("vocs-app"),
      location: LOCATION,
      memo: { include: ["src/**", "public/**", "package.json", "vocs.config.ts"] },
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
// two Standard_LRS accounts); ~5 min deploy, 10-20 min route propagation,
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

/** One GET that does not follow redirects. */
const fetchUnfollowed = (url: string) =>
  fetchPage(url).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

describe("Azure.Website.Vocs", { tags }, () => {
  test(
    "Front Door sends documentation pages to the server Function",
    Effect.gen(function* () {
      const { url, account, functionAppName } = yield* site;
      expect(url).toMatch(frontDoorUrl);
      expect(functionAppName!.length).toBeGreaterThan(0);

      const home = yield* waitForPage(
        `${url}/`,
        (page) => page.status === 200 && page.body.includes("VOCS_AZURE_PAGE_MARKER"),
        frontDoorWait,
      );
      expect(viaFrontDoor(home)).toBe(true);
      expect(home.body).toContain("Vocs Azure Fixture");
      const guide = yield* fetchPage(`${url}/guide`);
      expect(guide.status).toBe(200);
      expect(guide.body).toContain("VOCS_AZURE_GUIDE_MARKER");

      // Out of band: Blob Storage holds no page HTML, so the Function rendered it.
      const html = yield* webBlob(account!, "index.html").pipe(Effect.provide(azure));
      expect(html).toBeUndefined();
    }),
    { timeout: 1_800_000 },
  );

  test(
    "the Function redirects trailing slashes and answers RSC payloads",
    Effect.gen(function* () {
      const { url } = yield* site;
      const redirect = yield* waitForPage(
        `${url}/guide/`,
        (page) => page.status === 308,
        frontDoorWait,
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      expect(viaFrontDoor(redirect)).toBe(true);
      expect(redirect.headers.location).toBe("/guide");

      const rsc = yield* fetchUnfollowed(`${url}/RSC/R/guide.txt`);
      expect(rsc.status).toBe(200);
      expect(rsc.body).toContain("VOCS_AZURE_GUIDE_MARKER");
    }),
    { timeout: 1_800_000 },
  );

  test(
    "public files, llms.txt and hashed assets come from Blob Storage",
    Effect.gen(function* () {
      const { url } = yield* site;
      const hello = yield* waitForPage(
        `${url}/hello.txt`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(viaFrontDoor(hello)).toBe(true);
      expect(hello.body).toContain("vocs-azure-public-marker");
      const llms = yield* fetchPage(`${url}/llms.txt`);
      expect(llms.status).toBe(200);
      expect(llms.body).toContain("Vocs Azure Fixture");

      const home = yield* fetchPage(`${url}/`);
      const script = /src="(\/assets\/[^"]+\.js)"|href="(\/assets\/[^"]+\.js)"/.exec(home.body);
      const path = script?.[1] ?? script?.[2];
      expect(path).toMatch(/^\/assets\/.+\.js$/);
      const asset = yield* fetchPage(`${url}${path}`);
      expect(asset.status).toBe(200);
      expect(asset.headers["cache-control"]).toBe(assetCacheControl);
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
