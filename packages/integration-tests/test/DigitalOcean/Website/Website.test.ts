import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getApp } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { TestRegistry } from "../fixtures/app/shared.ts";
import { isGone, logLevel, skipSlow, waitForAppHost } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:website", "live"];
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const cloudflareWebsite = pathe.resolve(import.meta.dirname, "../../Cloudflare/Website");

// A team holds one registry, so each site deploys, answers and is
// destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "Vite SPA on App Platform: deploy, GET / and a client route, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* cloneFixture(pathe.join(cloudflareWebsite, "vite-spa-fixture"), {
        prefix: "alchemy-vite-digitalocean-",
        tempRoot,
        entries: ["index.html", "package.json", "src"],
      });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* DigitalOcean.Website.Vite("Web", {
            rootDir,
            registry: TestRegistry,
            memo: { include: ["index.html", "src/**", "package.json"] },
          });
          return { url: site.url, appId: site.app?.appId };
        }),
      );
      const url = deployed.url as string;
      expect(url).toMatch(/^https:\/\/.+\.ondigitalocean\.app/);
      yield* waitForAppHost(url);
      yield* expectUrlContains(`${url}/`, "Vite SPA fixture", {
        timeout: "90 seconds",
        label: "vite spa index",
      });
      yield* expectUrlContains(`${url}/missing-client-route`, "Vite SPA fixture", {
        timeout: "30 seconds",
        label: "vite spa fallback",
      });
      yield* stack.destroy();
      expect(yield* isGone(getApp({ id: deployed.appId! }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 2_700_000, exclusive: "digitalocean:registry" },
);

test.provider.skipIf(skipSlow)(
  "StaticSite on App Platform: build command + outdir, GET index, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const cwd = yield* cloneFixture(pathe.join(cloudflareWebsite, "staticsite-fixture"), {
        prefix: "alchemy-staticsite-digitalocean-",
        tempRoot,
        entries: ["src", "build.sh"],
      });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* DigitalOcean.Website.StaticSite("Blog", {
            cwd,
            command: "bash build.sh",
            outdir: "dist",
            registry: TestRegistry,
          });
          return { url: site.url, appId: site.app?.appId };
        }),
      );
      const url = deployed.url as string;
      yield* waitForAppHost(url);
      yield* expectUrlContains(`${url}/`, "StaticSite fixture v1", {
        timeout: "90 seconds",
        label: "staticsite index",
      });
      yield* stack.destroy();
      expect(yield* isGone(getApp({ id: deployed.appId! }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 2_700_000, exclusive: "digitalocean:registry" },
);
