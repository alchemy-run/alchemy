import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import EffectApp from "./fixtures/app/effect-app.ts";
import { TestRegistry } from "./fixtures/app/shared.ts";
import { logLevel, skipSlow } from "./support.ts";

const { beforeAll, afterAll, deploy, destroy, test } = Test.make({
  providers: DigitalOcean.providers(),
});

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:app", "live"];

const Stack = Alchemy.Stack(
  "DigitalOceanAppTest",
  { providers: DigitalOcean.providers(), state: Alchemy.localState() },
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

// A build, a push and a deployment take several minutes per app.
const stack = beforeAll(
  skipSlow
    ? Effect.succeed({ effectUrl: "", effectAppId: "", asyncUrl: "", asyncAppId: "" })
    : deploy(Stack),
  { timeout: 1_800_000, exclusive: "digitalocean:registry" },
);
afterAll.skipIf(skipSlow || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 900_000,
  exclusive: "digitalocean:registry",
});

const getJson = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    return (yield* response.json) as Record<string, unknown>;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }));

test.skipIf(skipSlow)(
  "an Effect app serves its handler over HTTPS",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    expect(effectUrl).toMatch(/^https:\/\/.+\.ondigitalocean\.app/);
    expect(yield* getJson(effectUrl)).toEqual({ runtime: "effect", ok: true });
  }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 300_000 },
);

test.skipIf(skipSlow)(
  "an async app serves a plain fetch handler with its env",
  Effect.gen(function* () {
    const { asyncUrl } = yield* stack;
    expect(yield* getJson(`${asyncUrl}/hello`)).toEqual({
      runtime: "async",
      greeting: "hello",
      path: "/hello",
    });
  }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 300_000 },
);
