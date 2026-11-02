import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cacheControlOf,
  cloudflareFixture,
  expectAssetSiteGone,
  expectThroughCdn,
  liveOptions,
  logLevel,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers() });

test.provider(
  "build v1, rebuild to v2 and purge what changed, redeploy unchanged, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* cloneFixture(cloudflareFixture("staticsite-fixture"), {
        prefix: "alchemy-staticsite-stackit-",
        tempRoot,
        entries: ["src", "build.sh"],
      });
      const app = Effect.gen(function* () {
        const site = yield* Stackit.Website.StaticSite("Blog", {
          cwd,
          command: "bash build.sh",
          outdir: "dist",
          memo: { include: ["src/**", "build.sh"] },
          tags: { suite: "website" },
        });
        return { site };
      });

      const first = yield* stack.deploy(app);
      const site = {
        url: first.site.url as string,
        projectId: first.site.distribution!.projectId,
        distributionId: first.site.distribution!.distributionId,
        hostname: first.site.distribution!.hostname,
      };
      expect(first.site.server).toBeUndefined();
      // A new distribution has nothing in its cache.
      expect(first.site.purge!.purgedPaths).toEqual([]);
      yield* expectThroughCdn(site, { type: "bucket" });
      const page = yield* cacheControlOf(`${site.url}/index.html`);
      expect(page.body).toContain("StaticSite fixture v1");
      expect(page.cacheControl).toContain("no-store");

      const index = path.join(cwd, "src", "index.html");
      yield* fs.writeFileString(
        index,
        (yield* fs.readFileString(index)).replaceAll("fixture v1", "fixture v2"),
      );
      const second = yield* stack.deploy(app);
      expect(second.site.url).toEqual(site.url);
      expect(second.site.purge!.purgedPaths).toEqual(["/", "/index.html"]);
      yield* expectUrlContains(`${site.url}/index.html`, "StaticSite fixture v2", {
        timeout: "120 seconds",
        label: "StaticSite v2 through the CDN",
      });

      // An unchanged build touches nothing.
      const plan = yield* stack.plan(app);
      expect(plan.resources["Blog/Files"]).toMatchObject({ action: "noop" });
      expect(plan.resources["Blog/Purge"]).toMatchObject({ action: "noop" });

      const bucket = {
        bucketName: second.site.bucket!.bucketName,
        region: second.site.bucket!.region,
      };
      yield* stack.destroy();
      yield* expectAssetSiteGone(site, bucket);
    }).pipe(logLevel),
  liveOptions(900_000),
);
