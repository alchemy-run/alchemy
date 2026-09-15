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

const HOST_CLUSTER_ID = "alch-np-host";
const HOST_LOCATION = "us-central1-a";

const waitUntilGone = (name: string) =>
  container.getProjectsLocationsClustersNodePools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitClusterOp = (project: string, operation: container.Operation) =>
  Effect.gen(function* () {
    const raw = operation.name ?? "";
    const fromLink = operation.selfLink ?? "";
    const name = raw.includes("/operations/")
      ? raw.slice(Math.max(0, raw.indexOf("projects/")))
      : fromLink.includes("/operations/")
        ? fromLink.slice(Math.max(0, fromLink.indexOf("projects/")))
        : `projects/${project}/locations/${HOST_LOCATION}/operations/${raw}`;
    if (operation.status === "DONE") return operation;
    return yield* container.getProjectsLocationsOperations({ name }).pipe(
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

test.provider.skipIf(!hasGcpCreds)(
  "lists clusters and treats a missing node pool as NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID!;
      const page = yield* container.listProjectsLocationsClusters({
        parent: `projects/${project}/locations/-`,
      });
      expect(Array.isArray(page.clusters ?? [])).toEqual(true);

      const missing = yield* container
        .getProjectsLocationsClustersNodePools({
          name: `projects/${project}/locations/${HOST_LOCATION}/clusters/alchemy-missing-cluster/nodePools/alchemy-missing-pool`,
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
  "create, update, and delete a node pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID!;
      const clusterName = `projects/${project}/locations/${HOST_LOCATION}/clusters/${HOST_CLUSTER_ID}`;

      const listed = yield* container.listProjectsLocationsClusters({
        parent: `projects/${project}/locations/-`,
      });
      const reusable = (listed.clusters ?? []).find(
        (cluster) =>
          cluster.status === "RUNNING" && cluster.autopilot?.enabled !== true,
      );
      const hostName = reusable
        ? `projects/${project}/locations/${reusable.location ?? HOST_LOCATION}/clusters/${reusable.name}`
        : clusterName;
      const hostLocation = reusable?.location ?? HOST_LOCATION;
      const hostId = reusable?.name ?? HOST_CLUSTER_ID;
      let createdHost = false;

      if (reusable === undefined) {
        const existing = yield* container
          .getProjectsLocationsClusters({ name: clusterName })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (existing === undefined || existing.status !== "RUNNING") {
          const created = yield* container.createProjectsLocationsClusters({
            parent: `projects/${project}/locations/${HOST_LOCATION}`,
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
          yield* waitClusterOp(project, created);
          createdHost = true;
        }
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Container.NodePool("Workers", {
            cluster: hostId,
            location: hostLocation,
            nodeCount: 1,
            machineType: "e2-medium",
            diskSizeGb: 20,
            spot: true,
            management: { autoRepair: false, autoUpgrade: true },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/nodePools/");
      expect(created.nodePoolId).toEqual(expect.any(String));
      expect(created.clusterId).toEqual(hostId);
      expect(created.location).toEqual(hostLocation);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.spot).toEqual(true);
      expect(created.nodeCount).toEqual(1);
      expect(["RUNNING", "RUNNING_WITH_ERROR"]).toContain(created.status);

      const fetched = yield* container.getProjectsLocationsClustersNodePools({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.nodePoolId);
      expect(fetched.config?.resourceLabels?.env).toEqual("test");
      expect(fetched.config?.spot).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Container.NodePool("Workers", {
            cluster: hostId,
            location: hostLocation,
            nodePoolId: created.nodePoolId,
            nodeCount: 1,
            machineType: "e2-medium",
            diskSizeGb: 20,
            spot: true,
            management: { autoRepair: true, autoUpgrade: true },
            labels: { env: "prod", role: "workers" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "workers" });
      expect(updated.management?.autoRepair).toEqual(true);

      const refetched = yield* container.getProjectsLocationsClustersNodePools({
        name: created.name,
      });
      expect(refetched.config?.resourceLabels?.env).toEqual("prod");
      expect(refetched.config?.resourceLabels?.role).toEqual("workers");
      expect(refetched.management?.autoRepair).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");

      if (createdHost) {
        const deleted = yield* container
          .deleteProjectsLocationsClusters({ name: hostName })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (deleted !== undefined) {
          yield* waitClusterOp(project, deleted);
        }
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);
