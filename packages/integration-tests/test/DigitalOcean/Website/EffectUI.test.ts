import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getApp } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { effectUIFixture, effectUIMemo, verifyEffectUIRendering } from "../../Website/EffectUI.ts";
import { TestRegistry } from "../fixtures/app/shared.ts";
import { isGone, logLevel, skipSlow, waitForAppHost } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the site deploys, answers and is destroyed
// inside one test holding the registry lock. Hybrid covers prerendered
// pages, the server handler and the not-found page in one deployment.
test.provider.skipIf(skipSlow)(
  "EffectUI on App Platform: hybrid renders every route, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* effectUIFixture("hybrid");
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* DigitalOcean.Website.EffectUI("Web", {
            rootDir,
            memo: effectUIMemo,
            registry: TestRegistry,
          });
          return { url: site.url, appId: site.app?.appId };
        }),
      );
      const url = deployed.url as string;
      expect(url).toMatch(/^https:\/\/.+\.ondigitalocean\.app/);
      yield* waitForAppHost(url);
      yield* verifyEffectUIRendering(url, "hybrid", { runtime: /Node\.js/ });

      yield* stack.destroy();
      expect(yield* isGone(getApp({ id: deployed.appId! }))).toBe(true);
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:website", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
