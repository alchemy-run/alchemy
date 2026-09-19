import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as container from "@distilled.cloud/gcp/container_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_GKE && !process.env.FAST;

const HOST_CLUSTER_ID = "alch-cnp-host";
const HOST_ZONE = "us-central1-a";

const isZone = (location: string) => /-[a-z0-9]$/.test(location);

const waitUntilGone = (
  project: string,
  zone: string,
  clusterId: string,
  nodePoolId: string,
) =>
  container
    .getProjectsZonesClustersNodePools({
      projectId: project,
      zone,
      clusterId,
      nodePoolId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitClusterOp = (
  project: string,
  zone: string,
  operation: container.Operation,
) =>
  Effect.gen(function* () {
    const raw = operation.name ?? "";
    const fromLink = operation.selfLink ?? "";
    const operationId = lastSegment(
      raw.includes("/operations/")
        ? raw
        : fromLink.includes("/operations/")
          ? fromLink
          : raw,
    );
    if (operation.status === "DONE") return operation;
    return yield* container
      .getProjectsZonesOperations({
        projectId: project,
        zone,
        operationId,
      })
      .pipe(
        Effect.flatMap((current) =>
          current.status === "DONE"
            ? Effect.succeed(current)
            : Effect.fail(current),
        ),
        Effect.retry({
          while: (current) => !("_tag" in current) && current.status !== "DONE",
          times: 10,
          schedule: Schedule.spaced("8 seconds"),
        }),
      );
  });

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

test.provider.skipIf(!hasGcpCreds)(
  "lists zonal clusters and treats a missing node pool as NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID!;
      const page = yield* container.listProjectsZonesClusters({
        projectId: project,
        zone: "-",
      });
      expect(Array.isArray(page.clusters ?? [])).toEqual(true);

      const missing = yield* container
        .getProjectsZonesClustersNodePools({
          projectId: project,
          zone: HOST_ZONE,
          clusterId: "alchemy-missing-cluster",
          nodePoolId: "alchemy-missing-pool",
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(missing).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a zonal node pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID!;

      const listed = yield* container.listProjectsZonesClusters({
        projectId: project,
        zone: "-",
      });
      const reusable = (listed.clusters ?? []).find((cluster) => {
        const location = cluster.zone ?? cluster.location ?? "";
        return (
          cluster.status === "RUNNING" &&
          cluster.autopilot?.enabled !== true &&
          isZone(location)
        );
      });
      const hostZone = reusable?.zone ?? reusable?.location ?? HOST_ZONE;
      const hostId = reusable?.name ?? HOST_CLUSTER_ID;
      let createdHost = false;

      if (reusable === undefined) {
        const existing = yield* container
          .getProjectsZonesClusters({
            projectId: project,
            zone: HOST_ZONE,
            clusterId: HOST_CLUSTER_ID,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (existing === undefined || existing.status !== "RUNNING") {
          const created = yield* container.createProjectsZonesClusters({
            projectId: project,
            zone: HOST_ZONE,
            body: {
              cluster: {
                name: HOST_CLUSTER_ID,
                ipAllocationPolicy: { useIpAliases: true },
                nodePools: [
                  {
                    name: "default-pool",
                    initialNodeCount: 1,
                    config: {
                      machineType: "e2-medium",
                      diskSizeGb: 20,
                      diskType: "pd-standard",
                      spot: true,
                    },
                  },
                ],
              },
            },
          });
          yield* waitClusterOp(project, HOST_ZONE, created);
          createdHost = true;
        }
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.Container.ClustersNodePool("Workers", {
            cluster: hostId,
            zone: hostZone,
            nodeCount: 1,
            machineType: "e2-medium",
            diskSizeGb: 20,
            spot: true,
            management: { autoRepair: false, autoUpgrade: true },
            labels: { env: "test" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* pool.name;
              const getPool = yield* GCP.Container.GetClustersNodePool(pool);
              return Effect.fn(function* () {
                return yield* getPool();
              });
            }),
          );
          return { pool, probe: yield* Probe({}) };
        }),
      );

      expect(created.pool.name).toContain("/nodePools/");
      expect(created.pool.nodePoolId).toEqual(expect.any(String));
      expect(created.pool.clusterId).toEqual(hostId);
      expect(created.pool.zone).toEqual(hostZone);
      expect(created.pool.labels).toMatchObject({ env: "test" });
      expect(created.pool.spot).toEqual(true);
      expect(created.pool.nodeCount).toEqual(1);
      expect(["RUNNING", "RUNNING_WITH_ERROR"]).toContain(created.pool.status);
      expect(created.probe.name).toEqual(created.pool.nodePoolId);

      const fetched = yield* container.getProjectsZonesClustersNodePools({
        projectId: project,
        zone: hostZone,
        clusterId: hostId,
        nodePoolId: created.pool.nodePoolId,
      });
      expect(fetched.name).toEqual(created.pool.nodePoolId);
      expect(fetched.config?.resourceLabels?.env).toEqual("test");
      expect(fetched.config?.spot).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Container.ClustersNodePool("Workers", {
            cluster: hostId,
            zone: hostZone,
            nodePoolId: created.pool.nodePoolId,
            nodeCount: 1,
            machineType: "e2-medium",
            diskSizeGb: 20,
            spot: true,
            management: { autoRepair: true, autoUpgrade: true },
            labels: { env: "prod", role: "workers" },
          });
        }),
      );

      expect(updated.name).toEqual(created.pool.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "workers" });
      expect(updated.management?.autoRepair).toEqual(true);

      const refetched = yield* container.getProjectsZonesClustersNodePools({
        projectId: project,
        zone: hostZone,
        clusterId: hostId,
        nodePoolId: created.pool.nodePoolId,
      });
      expect(refetched.config?.resourceLabels?.env).toEqual("prod");
      expect(refetched.config?.resourceLabels?.role).toEqual("workers");
      expect(refetched.management?.autoRepair).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        project,
        hostZone,
        hostId,
        created.pool.nodePoolId,
      );
      expect(gone).toEqual("gone");

      if (createdHost) {
        const deleted = yield* container
          .deleteProjectsZonesClusters({
            projectId: project,
            zone: HOST_ZONE,
            clusterId: HOST_CLUSTER_ID,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (deleted !== undefined) {
          yield* waitClusterOp(project, HOST_ZONE, deleted);
        }
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);
