import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as workstations from "@distilled.cloud/gcp/workstations_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_WORKSTATIONS;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsWorkstationClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workstations.getProjectsLocationsWorkstationClusters({
          name: `projects/${project}/locations/us-central1/workstationClusters/alchemy-missing-cluster`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* workstations
        .listProjectsLocationsWorkstationClusters({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ workstationClusters: [] as const }),
          ),
        );
      expect(Array.isArray(page.workstationClusters ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create against a missing network is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Workstations.WorkstationCluster("Dev", {
              network: `projects/${project}/global/networks/alchemy-missing-vpc`,
              subnetwork: `projects/${project}/regions/us-central1/subnetworks/alchemy-missing-subnet`,
              displayName: "alchemy-test-cluster",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Workstations.OperationFailed",
        "GCP.Workstations.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a workstation cluster, config, and workstation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Workstations.WorkstationCluster("Dev", {
            location: "us-central1",
            network: "default",
            subnetwork: "default",
            displayName: "alchemy-test-cluster",
            labels: { env: "test" },
          });
          const config =
            yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
              "Code",
              {
                workstationCluster: cluster.name,
                displayName: "alchemy-test-config",
                idleTimeout: "300s",
                host: {
                  gceInstance: {
                    machineType: "e2-standard-2",
                    poolSize: 0,
                    bootDiskSizeGb: 30,
                  },
                },
                labels: { env: "test" },
              },
            );
          const workstation =
            yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
              "Mine",
              {
                workstationConfig: config.name,
                displayName: "alchemy-test-station",
                labels: { env: "test" },
              },
            );
          return { cluster, config, workstation };
        }),
      );

      expect(created.cluster.name).toContain("/workstationClusters/");
      expect(created.cluster.labels).toMatchObject({ env: "test" });
      expect(created.config.workstationCluster).toEqual(created.cluster.name);
      expect(created.workstation.workstationConfig).toEqual(
        created.config.name,
      );

      const fetched =
        yield* workstations.getProjectsLocationsWorkstationClusters({
          name: created.cluster.name,
        });
      expect(fetched.name).toEqual(created.cluster.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Workstations.WorkstationCluster("Dev", {
            workstationClusterId: created.cluster.workstationClusterId,
            location: "us-central1",
            network: "default",
            subnetwork: "default",
            displayName: "alchemy-test-cluster-v2",
            labels: { env: "prod", role: "dev" },
          });
          const config =
            yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
              "Code",
              {
                workstationConfigId: created.config.workstationConfigId,
                workstationCluster: cluster.name,
                displayName: "alchemy-test-config-v2",
                idleTimeout: "600s",
                labels: { env: "prod" },
              },
            );
          const workstation =
            yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
              "Mine",
              {
                workstationId: created.workstation.workstationId,
                workstationConfig: config.name,
                displayName: "alchemy-test-station-v2",
                labels: { env: "prod" },
              },
            );
          return { cluster, config, workstation };
        }),
      );

      expect(updated.cluster.workstationClusterId).toEqual(
        created.cluster.workstationClusterId,
      );
      expect(updated.cluster.displayName).toEqual("alchemy-test-cluster-v2");
      expect(updated.cluster.labels).toMatchObject({
        env: "prod",
        role: "dev",
      });
      expect(updated.config.displayName).toEqual("alchemy-test-config-v2");
      expect(updated.workstation.displayName).toEqual(
        "alchemy-test-station-v2",
      );

      yield* stack.destroy();

      const gone = yield* workstations
        .getProjectsLocationsWorkstationClusters({
          name: created.cluster.name,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
