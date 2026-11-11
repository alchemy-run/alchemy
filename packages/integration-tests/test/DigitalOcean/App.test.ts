import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getApp } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import EffectApp from "./fixtures/app/effect-app.ts";
import { TestRegistry } from "./fixtures/app/shared.ts";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:app", "live"];

const getJson = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    return (yield* response.json) as Record<string, unknown>;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }));

// A team holds one registry, so every suite that pushes an image deploys,
// checks and destroys inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "Effect and async apps serve over HTTPS from the team registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { effectUrl, effectAppId, asyncUrl, asyncAppId } = yield* stack.deploy(
        Effect.gen(function* () {
          const effect = yield* EffectApp;
          const async = yield* DigitalOcean.App("AsyncApp", {
            main: new URL("./fixtures/app/async-app.ts", import.meta.url).pathname,
            registry: TestRegistry,
            region: "nyc",
            env: { GREETING: "hello" },
          });
          return {
            effectUrl: effect.url,
            effectAppId: effect.appId,
            asyncUrl: async.url,
            asyncAppId: async.appId,
          };
        }),
      );

      expect(effectUrl).toMatch(/^https:\/\/.+\.ondigitalocean\.app/);
      expect(yield* getJson(effectUrl)).toEqual({ runtime: "effect", ok: true });
      expect(yield* getJson(`${asyncUrl}/hello`)).toEqual({
        runtime: "async",
        greeting: "hello",
        path: "/hello",
      });

      yield* stack.destroy();
      expect(yield* isGone(getApp({ id: effectAppId }))).toBe(true);
      expect(yield* isGone(getApp({ id: asyncAppId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 2_700_000, exclusive: "digitalocean:registry" },
);
