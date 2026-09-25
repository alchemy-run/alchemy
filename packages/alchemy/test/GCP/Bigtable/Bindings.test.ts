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
  hasGcpCreds && !!process.env.GCP_TEST_BIGTABLE && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetInstance, GetCluster, and GetTable invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Db", {
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const cluster = yield* GCP.Bigtable.Cluster("Nodes", {
            instance: instance.name,
            clusterId: "cluster",
            location: "us-central1-b",
            serveNodes: 1,
            defaultStorageType: "HDD",
          });
          const table = yield* GCP.Bigtable.Table("Rows", {
            instance: instance.name,
            columnFamilies: {
              cf: { gcRule: { maxNumVersions: 1 } },
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* table.name;
              const getInstance = yield* GCP.Bigtable.GetInstance(instance);
              const getCluster = yield* GCP.Bigtable.GetCluster(cluster);
              const getTable = yield* GCP.Bigtable.GetTable(table);
              return Effect.fn(function* () {
                const liveInstance = yield* getInstance();
                const liveCluster = yield* getCluster();
                const liveTable = yield* getTable();
                return { liveInstance, liveCluster, liveTable };
              });
            }),
          );
          return { instance, cluster, table, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.liveInstance.name).toEqual(out.instance.name);
      expect(out.probe.liveCluster.name).toEqual(out.cluster.name);
      expect(out.probe.liveTable.name).toEqual(out.table.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
