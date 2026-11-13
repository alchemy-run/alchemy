import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow, waitForAppHost } from "../support.ts";
import SecretApp from "./fixtures/secret-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the app deploys, reads the secret and is
// destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App reads a secret's value through ReadSecret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* SecretApp;
          return { url: app.url };
        }),
      );
      yield* waitForAppHost(url);
      const client = yield* HttpClient.HttpClient;
      const text = yield* client.get(url).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text
            : Effect.fail(new Error(`HTTP ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(text).toEqual("hello from a secret");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:security", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
