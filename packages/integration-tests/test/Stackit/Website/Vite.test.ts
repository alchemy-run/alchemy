import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { noBuiltFunctions } from "../Functions/helpers.ts";
import { hostingFor } from "./fixtures/stack.ts";
import {
  cacheControlOf,
  cloudflareFixture,
  expectAssetSiteGone,
  expectFunctionServing,
  expectServerSiteGone,
  expectThroughCdn,
  hashedAssetOf,
  liveOptions,
  logLevel,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers() });

const fixtureDir = cloudflareFixture("vite-spa-fixture");
const fixtureEntries = ["index.html", "package.json", "src"];
const memo = { include: ["index.html", "src/**", "package.json"] };

test.provider(
  "assets only: a bucket behind the CDN, with no function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-stackit-",
        tempRoot,
        entries: fixtureEntries,
      });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Stackit.Website.Vite("Web", { rootDir, memo });
          return { site };
        }),
      );

      const { distribution, bucket, files } = deployed.site;
      const site = {
        url: deployed.site.url as string,
        projectId: distribution!.projectId,
        distributionId: distribution!.distributionId,
        hostname: distribution!.hostname,
      };
      expect(deployed.site.server).toBeUndefined();
      expect(files!.keys).toContain("index.html");
      expect(files!.keys).not.toContain("serve-node.mjs");
      yield* expectThroughCdn(site, { type: "bucket" });

      const page = yield* cacheControlOf(`${site.url}/index.html`);
      expect(page.body).toContain("Vite SPA fixture");
      expect(page.cacheControl).toContain("no-store");

      // A file with a content hash is cached for good, through the CDN.
      const asset = hashedAssetOf(page.body);
      expect(asset).toMatch(/\/assets\//);
      const hashed = yield* cacheControlOf(new URL(asset!, site.url).href);
      expect(hashed.cacheControl).toContain("immutable");

      // Unconfirmed behaviour of a bucket origin; see the catalog's Website notes.
      yield* expectUrlContains(`${site.url}/`, "Vite SPA fixture", {
        timeout: "60 seconds",
        label: "Vite / through the CDN",
      });

      yield* stack.destroy();
      yield* expectAssetSiteGone(site, {
        bucketName: bucket!.bucketName,
        region: bucket!.region,
      });
    }).pipe(logLevel),
  liveOptions(900_000),
);

describe.skipIf(noBuiltFunctions)("Stackit.Website.Vite on a Function", () => {
  test.provider(
    "origin: function serves deep links and hashed assets",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vite-function-stackit-",
          tempRoot,
          entries: fixtureEntries,
        });
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const hosting = yield* hostingFor("vite");
            const site = yield* Stackit.Website.Vite("Web", {
              ...hosting,
              rootDir,
              memo,
              origin: "function",
              assets: { notFoundHandling: "single-page-application" },
            });
            return { site };
          }),
        );

        const { distribution, server, serverUrl } = deployed.site;
        const site = {
          url: deployed.site.url as string,
          projectId: distribution!.projectId,
          distributionId: distribution!.distributionId,
          hostname: distribution!.hostname,
        };
        expect(deployed.site.bucket).toBeUndefined();
        yield* expectThroughCdn(site, { type: "http", originUrl: serverUrl as string });
        yield* expectFunctionServing(site.projectId, server!);

        // Only a server can answer a route with no file.
        const deepLink = yield* cacheControlOf(`${site.url}/counter/42`);
        expect(deepLink.body).toContain("Vite SPA fixture");
        const asset = hashedAssetOf(deepLink.body);
        expect(asset).toMatch(/\/assets\//);
        const hashed = yield* cacheControlOf(new URL(asset!, site.url).href);
        expect(hashed.cacheControl).toContain("immutable");

        yield* stack.destroy();
        yield* expectServerSiteGone(site, server!.functionId);
      }).pipe(logLevel),
    liveOptions(),
  );
});
