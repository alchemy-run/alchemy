import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

test.provider.skipIf(!runLifecycle)(
  "GetSchemaRegistry invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const registry = yield* GCP.Managedkafka.SchemaRegistry("Schemas", {
            location: "us-central1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* registry.name;
              const getRegistry =
                yield* GCP.Managedkafka.GetSchemaRegistry(registry);
              return Effect.fn(function* () {
                const live = yield* getRegistry();
                return { live };
              });
            }),
          );
          return { registry, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.registry.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetCluster and GetTopic invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Managedkafka.Cluster("Brokers", {
            location: "us-central1",
          });
          const topic = yield* GCP.Managedkafka.ClustersTopic("Events", {
            cluster: cluster.name,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* cluster.name;
              yield* topic.name;
              const getCluster = yield* GCP.Managedkafka.GetCluster(cluster);
              const getTopic = yield* GCP.Managedkafka.GetTopic(topic);
              return Effect.fn(function* () {
                const liveCluster = yield* getCluster();
                const liveTopic = yield* getTopic();
                return { liveCluster, liveTopic };
              });
            }),
          );
          return {
            cluster,
            topic,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.liveCluster.name).toEqual(out.cluster.name);
      expect(out.probe.liveTopic.name).toEqual(out.topic.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
