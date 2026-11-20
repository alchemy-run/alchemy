import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getApp } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { expectedEnv, getJson } from "../EnvValues.ts";
import EnvApp from "./fixtures/app/env-app.ts";
import { isGone, logLevel, skipSlow, waitForAppHost } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the app deploys, checks and destroys inside
// one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App reads env values as process env strings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvApp;
        }),
      );

      yield* waitForAppHost(app.url);
      const env = yield* getJson(app.url, { times: 40 });

      // Assert after destroy so a failure leaves nothing deployed.
      yield* stack.destroy();
      const gone = yield* isGone(getApp({ id: app.appId }));
      expect(env).toEqual(expectedEnv);
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:app", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
