import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { noBuiltFunctions } from "../Functions/helpers.ts";
import { hostingFor } from "./fixtures/stack.ts";
import {
  cloudflareFixture,
  expectAssetSiteGone,
  expectFunctionServing,
  expectServerSiteGone,
  expectThroughCdn,
  liveOptions,
  logLevel,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers() });

const fixtureDir = cloudflareFixture("foldkit-fixture");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];
const memo = { include: ["index.html", "src/**", "package.json", "vite.config.ts"] };

test.provider(
  "browser-only: a bucket behind the CDN, with no function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-foldkit-stackit-",
        tempRoot,
        entries: fixtureEntries,
      });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Stackit.Website.Foldkit("Web", { rootDir, memo });
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
      yield* expectThroughCdn(site, { type: "bucket" });
      yield* expectUrlContains(`${site.url}/index.html`, "Foldkit Fixture", {
        timeout: "180 seconds",
        label: "Foldkit /index.html through the CDN",
      });

      yield* stack.destroy();
      yield* expectAssetSiteGone(site, {
        bucketName: bucket!.bucketName,
        region: bucket!.region,
      });
    }).pipe(logLevel),
  liveOptions(900_000),
);

describe.skipIf(noBuiltFunctions)("Stackit.Website.Foldkit on a Function", () => {
  test.provider(
    "origin: function answers a deep link through the CDN",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-foldkit-function-stackit-",
          tempRoot,
          entries: fixtureEntries,
        });
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const hosting = yield* hostingFor("foldkit");
            const site = yield* Stackit.Website.Foldkit("Web", {
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
        yield* expectThroughCdn(site, { type: "http", originUrl: serverUrl as string });
        yield* expectFunctionServing(site.projectId, server!);

        // Only a server can answer a route with no file.
        yield* expectUrlContains(`${site.url}/counter/42`, "Foldkit Fixture", {
          timeout: "180 seconds",
          label: "Foldkit deep link through the CDN",
        });

        yield* stack.destroy();
        yield* expectServerSiteGone(site, server!.functionId);
      }).pipe(logLevel),
    liveOptions(),
  );
});
