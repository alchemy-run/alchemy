import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const sourceExists = (kafkaIngestSourceId: string) =>
  galaxy.kafkaIngestSource.getKafkaIngestSource({ kafkaIngestSourceId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

// Galaxy stores the source without connecting to the brokers.
const broker = `${UNVALIDATED_ENDPOINT}:9092`;

test.provider(
  "create a Kafka ingest source, change its auth, and replace it on new brokers",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const created = yield* stack.deploy(
        StarburstGalaxy.Ingest.KafkaIngestSource("Clicks", {
          brokers: [broker],
          auth: { type: "saslPlain", username: "galaxy", password: secret("kafka-v1") },
          cloudRegionId: "aws-us-east1",
        }),
      );
      const sourceId = created.kafkaIngestSourceId;
      const live = yield* galaxy.kafkaIngestSource.getKafkaIngestSource({
        kafkaIngestSourceId: sourceId,
      });
      expect(live.kafkaBrokers).toEqual([broker]);

      // Auth and description converge in place.
      const changed = yield* stack.deploy(
        StarburstGalaxy.Ingest.KafkaIngestSource("Clicks", {
          brokers: [broker],
          auth: {
            type: "saslScram",
            username: "galaxy",
            password: secret("kafka-v2"),
            scramType: "Sha512",
          },
          cloudRegionId: "aws-us-east1",
          description: "click stream",
        }),
      );
      expect(changed.kafkaIngestSourceId).toBe(sourceId);
      const changedLive = yield* galaxy.kafkaIngestSource.getKafkaIngestSource({
        kafkaIngestSourceId: sourceId,
      });
      expect(changedLive.description).toBe("click stream");

      // Other brokers are another source.
      const moved = yield* stack.deploy(
        StarburstGalaxy.Ingest.KafkaIngestSource("Clicks", {
          brokers: [broker, `${UNVALIDATED_ENDPOINT}:9093`],
          auth: { type: "saslPlain", username: "galaxy", password: secret("kafka-v1") },
          cloudRegionId: "aws-us-east1",
        }),
      );
      expect(moved.kafkaIngestSourceId).not.toBe(sourceId);
      yield* expectGone(sourceExists(sourceId));

      yield* stack.destroy();
      yield* expectGone(sourceExists(moved.kafkaIngestSourceId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:ingest", "live"],
    timeout: 480_000,
  },
);
