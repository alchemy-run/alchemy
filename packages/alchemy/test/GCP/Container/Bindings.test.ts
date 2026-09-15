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
  hasGcpCreds && !!process.env.GCP_TEST_GKE && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetCluster and GetNodePool invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Container.Cluster("App", {
            location: "us-central1",
          });
          const nodePool = yield* GCP.Container.NodePool("Workers", {
            cluster: cluster.name,
            nodeCount: 1,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* nodePool.name;
              const getCluster = yield* GCP.Container.GetCluster(cluster);
              const getNodePool = yield* GCP.Container.GetNodePool(nodePool);
              return Effect.fn(function* () {
                const liveCluster = yield* getCluster();
                const livePool = yield* getNodePool();
                return { liveCluster, livePool };
              });
            }),
          );
          return { cluster, nodePool, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.liveCluster.name).toEqual(out.cluster.clusterId);
      expect(out.probe.livePool.name).toEqual(out.nodePool.nodePoolId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
