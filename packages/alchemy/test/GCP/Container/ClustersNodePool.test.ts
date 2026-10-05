import * as container from "@distilled.cloud/gcp/container_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import { waitForOperation } from "@/GCP/Operation";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { CAPACITY_ZONE, withGkeClusterSlot } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// GKE cluster create and delete each take 5-10 minutes.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

// Pools stay empty: every GKE node holds an external IP and the project
// allows only 8 IN_USE_ADDRESSES per region, shared by every capacity test.
const POOL_NODE_COUNT = 0;

const HOST_CLUSTER_ID = "alch-cnp-host";
const HOST_ZONE = CAPACITY_ZONE;

const waitUntilGone = (project: string, zone: string, clusterId: string, nodePoolId: string) =>
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

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

// GKE cluster create/delete takes 5–10 minutes.
const waitClusterOp = (project: string, zone: string, operation: container.Operation) => {
  const raw = operation.name ?? "";
  const fromLink = operation.selfLink ?? "";
  const operationId = lastSegment(
    raw.includes("/operations/") ? raw : fromLink.includes("/operations/") ? fromLink : raw,
  );
  return waitForOperation(
    { ...operation, name: operationId },
    (id) =>
      container.getProjectsZonesOperations({
        projectId: project,
        zone,
        operationId: id,
      }),
    { budget: "20 minutes", interval: "10 seconds" },
  );
};

test.provider(
  "lists zonal clusters and treats a missing node pool as NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const page = yield* container.listProjectsZonesClusters({
        projectId: project,
        zone: "-",
      });
      expect((page.clusters ?? []).map((cluster) => cluster.name)).not.toContain(
        "alchemy-missing-cluster",
      );

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
  { tags: ["provider:gcp", "provider:gcp:container", "live"], timeout: 90_000 },
);

test.provider(
  "replaces a zonal node pool for create-only VM settings",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(GCP.Container.ClustersNodePool);
      const olds: GCP.Container.ClustersNodePoolProps = {
        cluster: "app",
        zone: HOST_ZONE,
        nodePoolId: "workers",
        shieldedInstanceConfig: { enableSecureBoot: false },
        advancedMachineFeatures: { enableNestedVirtualization: false },
      };
      const input = {
        id: "Workers",
        fqn: "Workers",
        instanceId: "instance",
        olds,
        oldBindings: [],
        newBindings: [],
        output: {
          nodePoolId: "workers",
          clusterId: "app",
          zone: HOST_ZONE,
          shieldedInstanceConfig: olds.shieldedInstanceConfig,
          advancedMachineFeatures: olds.advancedMachineFeatures,
        },
      } as const;

      const changed = yield* provider.diff!({
        ...input,
        news: { ...olds, advancedMachineFeatures: { enableNestedVirtualization: true } },
      } as never);
      expect(changed).toEqual({ action: "replace", deleteFirst: true });

      // Adoption: olds is absent, and observed GKE-injected metadata and
      // false-valued booleans must not be compared against user input that
      // never mentioned those keys.
      const adoptionInput = {
        ...input,
        olds: undefined,
        output: { ...input.output, metadata: { "disable-legacy-endpoints": "true" } },
      } as const;

      const adoptedNoMetadata = yield* provider.diff!({
        ...adoptionInput,
        news: { ...olds, metadata: {} },
      } as never);
      expect(adoptedNoMetadata).toBeUndefined();

      const adoptedShielded = yield* provider.diff!({
        ...adoptionInput,
        output: { ...adoptionInput.output, shieldedInstanceConfig: undefined },
        news: { ...olds, metadata: {}, shieldedInstanceConfig: { enableSecureBoot: false } },
      } as never);
      expect(adoptedShielded).toBeUndefined();

      // A row deployed before these props existed: olds never declared
      // metadata, but the observed pool carries GKE's injected key.
      // Spelling it out must not replace the pool.
      const declaredObserved = yield* provider.diff!({
        ...input,
        output: { ...input.output, metadata: { "disable-legacy-endpoints": "true" } },
        olds: { cluster: "app", zone: HOST_ZONE, nodePoolId: "workers" },
        news: {
          cluster: "app",
          zone: HOST_ZONE,
          nodePoolId: "workers",
          metadata: { "disable-legacy-endpoints": "true" },
        },
      } as never);
      expect(declaredObserved).toBeUndefined();
    }),
  { tags: ["unit", "provider:gcp", "provider:gcp:container", "local"] },
);

/**
 * A throwaway zonal host cluster without Workload Identity (the node pool
 * must not request GKE_METADATA on it). Owned by this test: a leftover from
 * an interrupted run is reused if RUNNING, replaced otherwise, and always
 * deleted when the test ends.
 */
const withHostCluster = <A, E, R>(project: string, body: Effect.Effect<A, E, R>) => {
  const ref = {
    projectId: project,
    zone: HOST_ZONE,
    clusterId: HOST_CLUSTER_ID,
  };
  const deleteHost = container.deleteProjectsZonesClusters(ref).pipe(
    Effect.flatMap((operation) => waitClusterOp(project, HOST_ZONE, operation)),
    Effect.catchTag("NotFound", () => Effect.void),
  );
  const ensureHost = Effect.gen(function* () {
    const existing = yield* container
      .getProjectsZonesClusters(ref)
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing?.status === "RUNNING") return;
    if (existing !== undefined) yield* deleteHost;
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
  });
  return ensureHost.pipe(Effect.andThen(body), Effect.ensuring(Effect.ignore(deleteHost)));
};

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a zonal node pool",
  (stack) =>
    withGkeClusterSlot(
      Effect.gen(function* () {
        yield* stack.destroy();
        const { project } = yield* GcpEnvironment.current;
        const hostId = HOST_CLUSTER_ID;
        const hostZone = HOST_ZONE;
        yield* withHostCluster(
          project,
          Effect.gen(function* () {
            const created = yield* stack.deploy(
              Effect.gen(function* () {
                const pool = yield* GCP.Container.ClustersNodePool("Workers", {
                  cluster: hostId,
                  zone: hostZone,
                  nodeCount: POOL_NODE_COUNT,
                  machineType: "e2-medium",
                  diskSizeGb: 20,
                  spot: true,
                  management: { autoRepair: false, autoUpgrade: true },
                  labels: { env: "test" },
                  metadata: { "disable-legacy-endpoints": "true" },
                  // The host has no Workload Identity, so GKE_METADATA is
                  // rejected; set the alternative explicitly.
                  workloadMetadataConfig: { mode: "GCE_METADATA" },
                  shieldedInstanceConfig: {
                    enableIntegrityMonitoring: true,
                    enableSecureBoot: true,
                  },
                  advancedMachineFeatures: { enableNestedVirtualization: false },
                });
                return { pool };
              }),
            );

            expect(created.pool.name).toContain("/nodePools/");
            expect(created.pool.nodePoolId).toEqual(expect.any(String));
            expect(created.pool.clusterId).toEqual(hostId);
            expect(created.pool.zone).toEqual(hostZone);
            expect(created.pool.labels).toMatchObject({ env: "test" });
            expect(created.pool.spot).toEqual(true);
            expect(created.pool.nodeCount).toEqual(POOL_NODE_COUNT);
            expect(created.pool.metadata["disable-legacy-endpoints"]).toEqual("true");
            expect(created.pool.workloadMetadataConfig?.mode).toEqual("GCE_METADATA");
            expect(created.pool.shieldedInstanceConfig?.enableSecureBoot).toEqual(true);
            expect(["RUNNING", "RUNNING_WITH_ERROR"]).toContain(created.pool.status);

            const fetched = yield* container.getProjectsZonesClustersNodePools({
              projectId: project,
              zone: hostZone,
              clusterId: hostId,
              nodePoolId: created.pool.nodePoolId,
            });
            expect(fetched.name).toEqual(created.pool.nodePoolId);
            expect(fetched.config?.resourceLabels?.env).toEqual("test");
            expect(fetched.config?.spot).toEqual(true);
            expect(fetched.config?.metadata?.["disable-legacy-endpoints"]).toEqual("true");
            expect(fetched.config?.workloadMetadataConfig?.mode).toEqual("GCE_METADATA");
            expect(fetched.config?.shieldedInstanceConfig?.enableSecureBoot).toEqual(true);

            const updated = yield* stack.deploy(
              Effect.gen(function* () {
                return yield* GCP.Container.ClustersNodePool("Workers", {
                  cluster: hostId,
                  zone: hostZone,
                  nodePoolId: created.pool.nodePoolId,
                  nodeCount: POOL_NODE_COUNT,
                  machineType: "e2-medium",
                  diskSizeGb: 20,
                  spot: true,
                  management: { autoRepair: true, autoUpgrade: true },
                  labels: { env: "prod", role: "workers" },
                  metadata: { "disable-legacy-endpoints": "true" },
                  // The host has no Workload Identity, so GKE_METADATA is
                  // rejected; set the alternative explicitly.
                  workloadMetadataConfig: { mode: "GCE_METADATA" },
                  shieldedInstanceConfig: {
                    enableIntegrityMonitoring: true,
                    enableSecureBoot: true,
                  },
                  advancedMachineFeatures: { enableNestedVirtualization: false },
                });
              }),
            );

            expect(updated.name).toEqual(created.pool.name);
            expect(updated.labels).toMatchObject({
              env: "prod",
              role: "workers",
            });
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

            const gone = yield* waitUntilGone(project, hostZone, hostId, created.pool.nodePoolId);
            expect(gone).toEqual("gone");
          }),
        );
      }),
    ).pipe(logLevel),
  // Host create ~6 min, pool create/update ~5 min, host delete ~5 min.
  {
    tags: ["provider:gcp", "provider:gcp:container", "live"],
    timeout: 1_800_000,
    retry: 0,
  },
);
