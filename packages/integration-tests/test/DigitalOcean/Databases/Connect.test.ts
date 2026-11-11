import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow, waitForAppHost } from "../support.ts";
import ConnectApp from "./fixtures/connect-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the app deploys, answers and is destroyed
// inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App queries Postgres with the connection string Connect binds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* ConnectApp;
          return { url: app.url };
        }),
      );
      yield* waitForAppHost(url);
      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(url).pipe(
        Effect.flatMap((response) => response.json),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(body).toMatchObject({ answer: 42 });
      // Connect(AppDb) reaches the database, not the cluster's defaultdb.
      expect((body as { database: string }).database).not.toEqual("defaultdb");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:databases", "live"],
    timeout: 3_600_000,
    exclusive: "digitalocean:registry",
  },
);
