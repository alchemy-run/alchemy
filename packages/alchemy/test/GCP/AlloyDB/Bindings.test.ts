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
  hasGcpCreds && !!process.env.GCP_TEST_ALLOYDB && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetCluster, GetInstance, and GetConnectionInfo invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("Db", {
            location: "us-central1",
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* instance.name;
              const getCluster = yield* GCP.AlloyDB.GetCluster(cluster);
              const getInstance = yield* GCP.AlloyDB.GetInstance(instance);
              const getInfo = yield* GCP.AlloyDB.GetConnectionInfo(instance);
              return Effect.fn(function* () {
                const liveCluster = yield* getCluster();
                const liveInstance = yield* getInstance();
                const info = yield* getInfo();
                return { liveCluster, liveInstance, info };
              });
            }),
          );
          return { cluster, instance, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.liveCluster.name).toEqual(out.cluster.name);
      expect(out.probe.liveInstance.name).toEqual(out.instance.name);
      expect(out.probe.info).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
