import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/digitalocean";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow, waitForAppHost } from "../support.ts";
import InferenceApp from "./fixtures/inference-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const getJson = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    if (response.status !== 200) return yield* Effect.fail(new Error(`HTTP ${response.status}`));
    return (yield* response.json) as Record<string, unknown>;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }));

// A team holds one registry, so the app deploys, calls each binding and is
// destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App calls Serverless Inference through its bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // The test team's token serves as the key: model access keys are made
      // in the control panel only.
      const { apiKey } = yield* yield* Credentials;
      const ambient = yield* ConfigProvider.ConfigProvider;
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* InferenceApp;
          return { url: app.url };
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ DO_TEST_KEY: Redacted.value(apiKey) }),
              ambient,
            ),
          ),
        ),
      );
      yield* waitForAppHost(url);

      // CreateChatCompletion answers on inference.do-ai.run.
      const chat = yield* getJson(`${url}/chat`);
      expect(String(chat.text).toLowerCase()).toContain("pong");
      // CreateEmbedding returns a vector.
      const embed = yield* getJson(`${url}/embed`);
      expect(embed.dims).toBeGreaterThan(0);
      // ListModels lists what the key can call.
      const models = yield* getJson(`${url}/models`);
      expect(models.count).toBeGreaterThan(0);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:inference", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
