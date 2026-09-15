import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_ALLOYDB && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  alloydb.getProjectsLocationsClustersInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsClustersInstances on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        alloydb.getProjectsLocationsClustersInstances({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-alloydb-missing/instances/alchemy-alloydb-missing`,
        }),
      );
      // Entitled accounts return NotFound. The testing SA currently gets
      // Forbidden (AlloyDB Admin / API not granted).
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* alloydb
        .listProjectsLocationsClustersInstances({
          parent: `projects/${project}/locations/-/clusters/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ instances: [] as const }),
          ),
        );
      expect(Array.isArray(page.instances ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an alloydb instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-instance-cluster",
            labels: { env: "test" },
            initialUser: { user: "postgres", password: "AlchemyTest1" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceType: "PRIMARY",
            displayName: "alchemy-test-primary",
            labels: { env: "test" },
            machineConfig: { cpuCount: 2 },
          });
          return { cluster, instance };
        }),
      );

      expect(created.instance.name).toContain("/instances/");
      expect(created.instance.clusterId).toEqual(created.cluster.clusterId);
      expect(created.instance.location).toEqual("us-central1");
      expect(created.instance.instanceType).toEqual("PRIMARY");
      expect(created.instance.displayName).toEqual("alchemy-test-primary");
      expect(created.instance.labels).toMatchObject({ env: "test" });
      expect(created.instance.machineConfig?.cpuCount).toEqual(2);
      expect(["READY", "STOPPED"]).toContain(created.instance.state);

      const fetched = yield* alloydb.getProjectsLocationsClustersInstances({
        name: created.instance.name,
      });
      expect(fetched.name).toEqual(created.instance.name);
      expect(fetched.instanceType).toEqual("PRIMARY");
      expect(fetched.displayName).toEqual("alchemy-test-primary");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.machineConfig?.cpuCount).toEqual(2);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-instance-cluster",
            labels: { env: "test" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceId: created.instance.instanceId,
            instanceType: "PRIMARY",
            displayName: "alchemy-prod-primary",
            labels: { env: "prod", role: "primary" },
            machineConfig: { cpuCount: 2 },
          });
          return { cluster, instance };
        }),
      );

      expect(updated.instance.name).toEqual(created.instance.name);
      expect(updated.instance.displayName).toEqual("alchemy-prod-primary");
      expect(updated.instance.labels).toMatchObject({
        env: "prod",
        role: "primary",
      });

      const refetched = yield* alloydb.getProjectsLocationsClustersInstances({
        name: created.instance.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-primary");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("primary");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.instance.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
