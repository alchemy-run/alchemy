import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { listFunctionsAccessKey } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow, waitForAppHost } from "../support.ts";
import FunctionsApp, { Fns } from "./fixtures/functions-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the app deploys, calls the function and is
// destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App invokes a function through InvokeFunction with its own access key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url, namespaceId } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* FunctionsApp;
          const fns = yield* Fns;
          return { url: app.url, namespaceId: fns.namespaceId };
        }),
      );
      // The binding minted one access key for the App.
      const keys = yield* listFunctionsAccessKey({ namespace_id: namespaceId });
      expect(keys.access_keys?.length).toEqual(1);

      yield* waitForAppHost(url);
      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(url).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`HTTP ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(body).toEqual({ sum: 42 });
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:functions", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
