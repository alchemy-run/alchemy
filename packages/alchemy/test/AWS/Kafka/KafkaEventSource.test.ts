import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import KafkaTestFunctionLive, {
  FixtureCluster,
  KafkaTestFunction,
} from "./kafka-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// The MSK Serverless cluster this test provisions takes ~5-10 minutes to
// create and is metered while it exists, so the whole event-source e2e is
// gated behind AWS_TEST_SLOW=1. It deploys a cluster + a Lambda that binds
// `consumeKafkaTopic`, then verifies the event source mapping was created and
// points at the cluster with the configured topic. (A full produce/consume
// roundtrip additionally requires a Kafka admin/producer with MSK IAM auth to
// create and write the topic, which is out of scope here.)
describe.sequential("AWS.Kafka.KafkaEventSource", () => {
  test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
    "creates an event source mapping pointing a Lambda at the cluster topic",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { cluster, fn } = yield* stack.deploy(
          Effect.gen(function* () {
            const { cluster } = yield* FixtureCluster;
            const fn = yield* KafkaTestFunction;
            return { cluster, fn };
          }).pipe(Effect.provide(KafkaTestFunctionLive)),
        );

        expect(cluster.clusterArn).toContain(":cluster/");

        // Verify the event source mapping exists, targets the cluster, and
        // carries the configured topic. MSK ESMs progress
        // CREATING -> ENABLING -> ENABLED; assert it reached at least CREATING
        // and never FAILED.
        const mapping = yield* waitForMapping(
          fn.functionName,
          cluster.clusterArn,
        );
        expect(mapping.Topics).toEqual(["orders"]);
        expect(mapping.State).not.toBe("Failed");

        yield* stack.destroy();
      }),
    { timeout: 1_200_000 },
  );
});

class MappingNotReady extends Data.TaggedError("MappingNotReady")<{}> {}

const waitForMapping = Effect.fn(function* (
  functionName: string,
  eventSourceArn: string,
) {
  return yield* Lambda.listEventSourceMappings({
    FunctionName: functionName,
    EventSourceArn: eventSourceArn,
  }).pipe(
    Effect.flatMap((result) => {
      const mapping = result.EventSourceMappings?.[0];
      return mapping?.UUID
        ? Effect.succeed(mapping)
        : Effect.fail(new MappingNotReady());
    }),
    Effect.retry({
      while: (e) => e._tag === "MappingNotReady",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(24)),
      ),
    }),
  );
});
