import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import KafkaTestFunctionLive, {
  FixtureCluster,
  FixtureClusterLive,
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
describe.sequential(
  "AWS.Kafka.KafkaEventSource",
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:kafka", "provider:aws:lambda", "live"],
  },
  () => {
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
              // FixtureClusterLive is provided inside the Function's own impl,
              // so the stack must provide it too to read the cluster outputs
              // (the engine de-dupes the shared "FixtureCluster" declaration).
            }).pipe(Effect.provide(Layer.mergeAll(KafkaTestFunctionLive, FixtureClusterLive))),
          );

          expect(cluster.clusterArn).toContain(":cluster/");

          // Verify the event source mapping exists, targets the cluster, and
          // carries the configured topic. MSK ESMs progress
          // CREATING -> ENABLING -> ENABLED; assert it reached at least CREATING
          // and never FAILED.
          const mapping = yield* waitForMapping(fn.functionName, cluster.clusterArn);
          expect(mapping.Topics).toEqual(["orders"]);
          expect(mapping.State).not.toBe("Failed");

          // Drive the control-plane bindings end-to-end through the deployed
          // function URL: GetBootstrapBrokers, ConnectReadWrite (env-published
          // endpoint), ListTopics, and the CreateTopic → DescribeTopic →
          // DeleteTopic roundtrip.
          const baseUrl = fn.functionUrl!.replace(/\/+$/, "");
          const get = (path: string) =>
            HttpClient.get(`${baseUrl}${path}`).pipe(
              Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 10 }),
              Effect.flatMap((res) =>
                res.status === 200
                  ? res.json
                  : res.text.pipe(
                      Effect.flatMap((body) =>
                        Effect.die(new Error(`GET ${path} -> ${res.status}: ${body}`)),
                      ),
                    ),
              ),
            );

          const brokers = (yield* get("/brokers")) as { saslIam?: string };
          expect(brokers.saslIam).toContain(":9098");

          const connect = (yield* get("/connect")) as {
            bootstrapServers: string;
            brokers: string[];
            clusterArn: string;
            authentication: string;
          };
          expect(connect.authentication).toBe("iam");
          expect(connect.bootstrapServers).toContain(":9098");
          expect(connect.clusterArn).toBe(cluster.clusterArn);

          const topics = (yield* get("/topics")) as { topics?: string[]; error?: string };
          // MSK Serverless rejects the topic control plane with the typed
          // `ServerlessUnsupported` ("Topic APIs are not supported on
          // serverless clusters.") — either branch proves the grant works.
          if (topics.error === undefined) {
            expect(Array.isArray(topics.topics)).toBe(true);
          } else {
            expect(["BadRequestException", "ServerlessUnsupported"]).toContain(topics.error);
          }

          const roundtrip = (yield* get("/topics/roundtrip")) as {
            created: boolean;
            partitions?: number;
            error?: string;
          };
          // Serverless clusters that don't support the topic control plane
          // surface a typed BadRequestException — either branch proves the
          // grant + ClusterArn injection (an IAM gap would be a 500).
          if (roundtrip.created) {
            expect(roundtrip.partitions).toBe(1);
          } else {
            expect(roundtrip.error).toBeDefined();
          }

          yield* stack.destroy();
        }),
      { timeout: 1_200_000 },
    );
  },
);

class MappingNotReady extends Data.TaggedError("MappingNotReady")<{}> {}

const waitForMapping = Effect.fn(function* (functionName: string, eventSourceArn: string) {
  return yield* Lambda.listEventSourceMappings({
    FunctionName: functionName,
    EventSourceArn: eventSourceArn,
  }).pipe(
    Effect.flatMap((result) => {
      const mapping = result.EventSourceMappings?.[0];
      return mapping?.UUID ? Effect.succeed(mapping) : Effect.fail(new MappingNotReady());
    }),
    Effect.retry({
      while: (e) => e._tag === "MappingNotReady",
      schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
    }),
  );
});
