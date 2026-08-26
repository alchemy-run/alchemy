import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_MANAGEDKAFKA;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  kafka.getProjectsLocationsClustersTopics({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsClustersTopics on a missing topic fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsClustersTopics({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-missing/topics/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a kafka topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Managedkafka.Cluster("Brokers", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const topic = yield* GCP.Managedkafka.ClustersTopic("Events", {
            cluster: cluster.name,
            partitionCount: 1,
            replicationFactor: 3,
            configs: { "retention.ms": "86400000" },
          });
          return { cluster, topic };
        }),
      );

      expect(created.topic.name).toContain("/topics/");
      expect(created.topic.partitionCount).toEqual(1);

      const fetched = yield* kafka.getProjectsLocationsClustersTopics({
        name: created.topic.name,
      });
      expect(fetched.name).toEqual(created.topic.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Managedkafka.Cluster("Brokers", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const topic = yield* GCP.Managedkafka.ClustersTopic("Events", {
            cluster: cluster.name,
            topicId: created.topic.topicId,
            partitionCount: 3,
            replicationFactor: 3,
            configs: { "retention.ms": "172800000" },
          });
          return { cluster, topic };
        }),
      );
      expect(updated.topic.topicId).toEqual(created.topic.topicId);
      expect(updated.topic.partitionCount).toEqual(3);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.topic.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 240_000 },
);
