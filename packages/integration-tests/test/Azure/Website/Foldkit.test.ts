import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import {
  foldkitFixture,
  foldkitMemo,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/Foldkit.ts";
import {
  assertGroupGone,
  fetchPage,
  FRONT_DOOR_TIMEOUT,
  frontDoorUrl,
  frontDoorWait,
  getEndpoint,
  getProfile,
  LOCATION,
  logLevel,
  staticWebsiteEnabled,
  storageWebUrl,
  tags,
  viaFrontDoor,
  waitForPage,
  webBlob,
} from "./site.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Azure credentials and environment for hooks and out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

/**
 * One Front Door profile for the whole file (a profile delete takes 14-30
 * minutes): an SSR build on a Function and a browser-only SPA, each on its
 * own endpoint.
 */
const Stack = Alchemy.Stack(
  "AzureWebsiteFoldkit",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const ssrRoot = yield* foldkitFixture("ssr").pipe(Effect.orDie);
    const spaRoot = yield* foldkitFixture("spa").pipe(Effect.orDie);
    const profile = yield* Azure.Cdn.Profile("Edge");
    const ssr = yield* Azure.Website.Foldkit("Ssr", {
      rootDir: ssrRoot,
      location: LOCATION,
      output: "server",
      frontDoor: { profile },
      memo: foldkitMemo,
    });
    // Deliberately no `output` or `assets`: the SPA default is under test.
    const spa = yield* Azure.Website.Foldkit("Spa", {
      rootDir: spaRoot,
      location: LOCATION,
      frontDoor: { profile },
      memo: foldkitMemo,
    });
    return {
      profileGroup: profile.resourceGroup,
      profileName: profile.profileName,
      group: ssr.resourceGroup?.resourceGroupName,
      ssrUrl: ssr.url,
      ssrServer: ssr.server?.functionAppName,
      ssrAccount: ssr.storageAccount?.storageAccountName,
      ssrEndpoint: ssr.frontDoor?.endpoint.endpointName,
      spaUrl: spa.url,
      spaServer: spa.server?.functionAppName,
      spaAccount: spa.storageAccount?.storageAccountName,
    };
  }),
);

// ~$0.10/run (Front Door Standard by the hour, a Flex Consumption Function,
// three Standard_LRS accounts); ~5 min deploy, 10-20 min propagation, then a
// 14-30 min profile delete.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

const outputs = Effect.map(stack, (out) => ({
  profileGroup: out.profileGroup as string,
  profileName: out.profileName as string,
  group: out.group as string,
  ssrUrl: out.ssrUrl as string,
  ssrServer: out.ssrServer as string | undefined,
  ssrAccount: out.ssrAccount as string,
  ssrEndpoint: out.ssrEndpoint as string,
  spaUrl: out.spaUrl as string,
  spaServer: out.spaServer as string | undefined,
  spaAccount: out.spaAccount as string,
}));

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
        expect(prerendered.server).toBeUndefined();
        // The storage endpoint serves the uncompressed bundle slowly from
        // outside Azure, so this checks the pages; the Front Door cases run
        // the full rendering check.
        const home = yield* waitForPage(`${url}/?count=7`, (page) =>
          /id="count"[^>]*>0</.test(page.body),
        );
        expect(home.status).toBe(200);
        const about = yield* fetchPage(`${url}/about/?count=9`);
        expect(about.status).toBe(200);
        expect(about.body).toMatch(/id="count"[^>]*>0</);
        expect((yield* fetchPage(`${url}/foldkit-probe.txt`)).body).toBe("FOLDKIT_STATIC_ASSET");
        // No SPA fallback for a prerendered build.
        expect((yield* fetchPage(`${url}/not-prerendered`)).status).toBe(404);

        const groupName = prerendered.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );

  test(
    "an SSR build renders pages on the Function behind Front Door",
    Effect.gen(function* () {
      const out = yield* outputs;
      expect(out.ssrUrl).toMatch(frontDoorUrl);
      expect(out.ssrServer!.length).toBeGreaterThan(0);

      // Out of band: the endpoint serves the site's host, and Blob Storage
      // holds the client directory only.
      const endpoint = yield* getEndpoint(out.profileGroup, out.profileName, out.ssrEndpoint);
      expect(endpoint?.properties?.hostName).toBe(new URL(out.ssrUrl).host);
      const probeBlob = yield* webBlob(out.ssrAccount, "foldkit-probe.txt");
      expect(probeBlob?.cacheControl).toBe(assetCacheControl);
      expect(yield* webBlob(out.ssrAccount, "serve-azure.mjs")).toBeUndefined();

      // Both routes propagate: the asset route (Blob) and `/*` (the Function).
      // `count=7` reaches the page only when Foldkit's handler renders it.
      const probe = yield* waitForPage(
        `${out.ssrUrl}/foldkit-probe.txt`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(viaFrontDoor(probe)).toBe(true);
      expect(probe.body).toBe("FOLDKIT_STATIC_ASSET");
      const home = yield* waitForPage(
        `${out.ssrUrl}/?count=7`,
        (page) => page.status === 200 && /id="count"[^>]*>7</.test(page.body),
        frontDoorWait,
      );
      expect(viaFrontDoor(home)).toBe(true);
      yield* verifyFoldkitRendering(out.ssrUrl, "ssr");
      yield* verifyFoldkitBrowser(out.ssrUrl, "ssr");
    }).pipe(Effect.provide(azure), logLevel),
    { timeout: FRONT_DOOR_TIMEOUT },
  );

  test(
    "a browser-only SPA answers deep links with the shell through Front Door",
    Effect.gen(function* () {
      const out = yield* outputs;
      expect(out.spaUrl).toMatch(frontDoorUrl);
      expect(out.spaServer).toBeUndefined();
      expect(yield* staticWebsiteEnabled(out.spaAccount)).toBe(true);

      const home = yield* waitForPage(
        `${out.spaUrl}/`,
        (page) => page.status === 200 && page.body.includes("Foldkit Fixture"),
        frontDoorWait,
      );
      expect(viaFrontDoor(home)).toBe(true);
      // Front Door rewrites the deep link to the shell with a 200.
      const deepLink = yield* waitForPage(
        `${out.spaUrl}/counter/42`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(deepLink.body).toContain("Foldkit Fixture");
      yield* verifyFoldkitRendering(out.spaUrl, "spa");
    }).pipe(Effect.provide(azure), logLevel),
    { timeout: FRONT_DOOR_TIMEOUT },
  );
});

// Destroy (also after a failed deploy), then prove the shared profile and
// the stack's group are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const deployed = yield* Effect.exit(outputs);
    yield* destroy(Stack);
    if (Exit.isSuccess(deployed)) {
      const out = deployed.value;
      expect(yield* getProfile(out.profileGroup, out.profileName)).toBeUndefined();
      yield* assertGroupGone(out.group);
    }
  }).pipe(Effect.provide(azure), logLevel),
  { timeout: 2_400_000 },
);
