import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getMonitoringDestination } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:monitoring", "live"];

// DigitalOcean stores an external endpoint without connecting to it.
const destination = (retentionDays: number) =>
  DigitalOcean.Monitoring.Destination("Logs", {
    opensearch: {
      endpoint: "https://opensearch.example.com:9200",
      username: "alchemy",
      password: Redacted.make("not-a-real-password"),
      indexName: "alchemy-logs",
      retentionDays,
    },
  });

test.provider(
  "log destination: create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(destination(7));
      expect(created.type).toEqual("OPENSEARCH_EXT");
      const observed = yield* getMonitoringDestination({ destination_uuid: created.destinationId });
      expect(observed.destination.config?.endpoint).toEqual("https://opensearch.example.com:9200");

      const updated = yield* stack.deploy(destination(14));
      expect(updated.destinationId).toEqual(created.destinationId);
      const after = yield* getMonitoringDestination({ destination_uuid: created.destinationId });
      expect(after.destination.config?.retention_days).toEqual(14);

      yield* stack.destroy();
      expect(
        yield* isGone(getMonitoringDestination({ destination_uuid: created.destinationId })),
      ).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);
