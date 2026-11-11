import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getVectorDatabase } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel, skipSlow, waitForAppHost } from "../support.ts";
import VectorDbApp, { Vectors } from "./fixtures/vectordb-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:vectordb", "live"];

// A team holds one registry, so the app deploys, reads the database through
// Connect and is destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "vector database: create, an App connects with the bound key, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* VectorDbApp;
          const db = yield* Vectors;
          return { url: app.url, databaseId: db.databaseId, http: db.httpEndpoint };
        }),
      );
      expect(deployed.http).toMatch(/^https:\/\/.+\.weaviate\.ondigitalocean\.com/);

      yield* waitForAppHost(deployed.url);
      const client = yield* HttpClient.HttpClient;
      const meta = (yield* client.get(deployed.url).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`HTTP ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      )) as { status: number; version?: string };
      expect(meta.status).toEqual(200);
      expect(meta.version).toMatch(/^\d+\.\d+/);

      yield* stack.destroy();
      expect(
        yield* isGone(getVectorDatabase({ id: deployed.databaseId })).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (gone) => gone,
            times: 24,
          }),
        ),
      ).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 2_700_000, exclusive: "digitalocean:registry" },
);
