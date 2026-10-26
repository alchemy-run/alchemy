import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import { assetCacheControl, htmlCacheControl } from "alchemy/Website/assets";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
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
  tags,
  tempRoot,
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

/** The Astro fixture shared with the AWS suite: on-demand `/`, `/api/hello`, a prerendered page, `robots.txt`. */
const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/astro-app");
const fixtureEntries = [".gitignore", "package.json", "astro.config.mjs", "src", "public"];
const memo = { include: ["src/**", "public/**", "package.json", "astro.config.mjs"] };

const clone = (prefix: string) =>
  cloneFixture(fixtureDir, { prefix, tempRoot, entries: fixtureEntries }).pipe(Effect.orDie);

/**
 * One Front Door profile for the whole file (a profile delete takes 14-30
 * minutes): a server build and a static build, each on its own endpoint.
 */
const Stack = Alchemy.Stack(
  "AzureWebsiteAstro",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const ssrRoot = yield* clone("alchemy-astro-azure-ssr-");
    const staticRoot = yield* clone("alchemy-astro-azure-static-");
    const profile = yield* Azure.Cdn.Profile("Edge");
    const ssr = yield* Azure.Website.Astro("Ssr", {
      rootDir: ssrRoot,
      location: LOCATION,
      frontDoor: { profile },
      memo,
    });
    const prerendered = yield* Azure.Website.Astro("Static", {
      rootDir: staticRoot,
      location: LOCATION,
      astro: { output: "static" },
      frontDoor: { profile },
      memo,
    });
    return {
      profileGroup: profile.resourceGroup,
      profileName: profile.profileName,
      ssrUrl: ssr.url,
      ssrServer: ssr.server?.functionAppName,
      ssrAccount: ssr.storageAccount?.storageAccountName,
      ssrEndpoint: ssr.frontDoor?.endpoint.endpointName,
      ssrGroup: ssr.resourceGroup?.resourceGroupName,
      staticUrl: prerendered.url,
      staticServer: prerendered.server?.functionAppName,
      staticAccount: prerendered.storageAccount?.storageAccountName,
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
  ssrUrl: out.ssrUrl as string,
  ssrServer: out.ssrServer as string | undefined,
  ssrAccount: out.ssrAccount as string,
  ssrEndpoint: out.ssrEndpoint as string,
  ssrGroup: out.ssrGroup as string,
  staticUrl: out.staticUrl as string,
  staticServer: out.staticServer as string | undefined,
  staticAccount: out.staticAccount as string,
}));

describe("Azure.Website.Astro", { tags }, () => {
  test(
    "a server build renders pages on the Function and serves assets from Blob Storage",
    Effect.gen(function* () {
      const out = yield* outputs;
      expect(out.ssrUrl).toMatch(frontDoorUrl);
      expect(out.ssrServer!.length).toBeGreaterThan(0);
      const host = new URL(out.ssrUrl).host;

      // Out of band: the endpoint serves the site's host, and Blob Storage
      // holds the client directory (no server files).
      const endpoint = yield* getEndpoint(out.profileGroup, out.profileName, out.ssrEndpoint);
      expect(endpoint?.properties?.hostName).toBe(host);
      const prerenderedBlob = yield* webBlob(out.ssrAccount, "prerendered/index.html");
      expect(prerenderedBlob?.cacheControl).toBe(htmlCacheControl);
      expect(yield* webBlob(out.ssrAccount, "serve-azure.mjs")).toBeUndefined();

      // `/` renders on demand on the Function, which sees the Front Door host.
      const home = yield* waitForPage(
        `${out.ssrUrl}/`,
        (page) => page.status === 200 && page.body.includes("ASTRO_AWS_PAGE_MARKER"),
        frontDoorWait,
      );
      expect(viaFrontDoor(home)).toBe(true);
      expect(home.body).toContain('<p id="mode">on-demand</p>');
      expect(home.body).toContain(`<p id="host">${host}</p>`);

      // An API route runs on the Function too.
      const api = yield* waitForPage(
        `${out.ssrUrl}/api/hello?echo=roundtrip`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(JSON.parse(api.body)).toEqual({ marker: "ASTRO_AWS_API_MARKER", echo: "roundtrip" });

      // `public/` files and prerendered pages come from Blob Storage.
      const robots = yield* waitForPage(
        `${out.ssrUrl}/robots.txt`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(viaFrontDoor(robots)).toBe(true);
      expect(robots.body).toContain("astro-aws-robots-marker");
      expect(robots.headers["cache-control"]).toBe(assetCacheControl);
      const prerendered = yield* fetchPage(`${out.ssrUrl}/prerendered/`);
      expect(prerendered.status).toBe(200);
      expect(prerendered.body).toContain("ASTRO_AWS_PRERENDERED_MARKER");
      expect(prerendered.headers["cache-control"]).toBe(htmlCacheControl);
    }).pipe(Effect.provide(azure), logLevel),
    { timeout: FRONT_DOOR_TIMEOUT },
  );

  test(
    "a static build deploys its client directory only",
    Effect.gen(function* () {
      const out = yield* outputs;
      expect(out.staticUrl).toMatch(frontDoorUrl);
      expect(out.staticServer).toBeUndefined();

      // Out of band: the prerendered pages are in `$web`; the Node serve
      // entry the build wrote into the client directory is not.
      const index = yield* webBlob(out.staticAccount, "index.html");
      expect(index?.contentType).toBe("text/html; charset=utf-8");
      expect(yield* webBlob(out.staticAccount, "serve-node.mjs")).toBeUndefined();

      const home = yield* waitForPage(
        `${out.staticUrl}/`,
        (page) => page.status === 200 && page.body.includes("ASTRO_AWS_PAGE_MARKER"),
        frontDoorWait,
      );
      expect(viaFrontDoor(home)).toBe(true);
      // Prerendered at build time: no request reached a server.
      expect(home.body).toContain('<p id="method">GET</p>');
      expect(home.body).not.toContain(`<p id="host">${new URL(out.staticUrl).host}</p>`);
      const prerendered = yield* waitForPage(
        `${out.staticUrl}/prerendered/`,
        (page) => page.status === 200,
        frontDoorWait,
      );
      expect(prerendered.body).toContain("ASTRO_AWS_PRERENDERED_MARKER");
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
      yield* assertGroupGone(out.ssrGroup);
    }
  }).pipe(Effect.provide(azure), logLevel),
  { timeout: 2_400_000 },
);
