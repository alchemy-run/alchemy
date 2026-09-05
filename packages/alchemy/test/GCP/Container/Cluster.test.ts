import * as GCP from "@/GCP";
import { findClusterAdapter } from "@/Kubernetes/ClusterAdapter.ts";
import * as Provider from "@/Provider";
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

const waitUntilGone = (name: string) =>
  container.getProjectsLocationsClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider("plans create-only cluster topology as replacement", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(GCP.Container.Cluster);
    const olds: GCP.Container.ClusterProps = {
      clusterId: "app",
      location: "us-central1-a",
      ipAllocationPolicy: {
        useIpAliases: true,
        clusterSecondaryRangeName: "pods-a",
        servicesSecondaryRangeName: "services-a",
      },
      privateClusterConfig: {
        enablePrivateNodes: true,
        enablePrivateEndpoint: false,
        masterIpv4CidrBlock: "172.16.0.0/28",
        masterGlobalAccessConfig: { enabled: false },
      },
    };
    const input = {
      id: "App",
      fqn: "App",
      instanceId: "instance",
      olds,
      oldBindings: [],
      newBindings: [],
      output: {
        clusterId: "app",
        location: "us-central1-a",
        autopilot: false,
        enableKubernetesAlpha: false,
      },
    } as const;

    const endpointOnly = yield* provider.diff!({
      ...input,
      news: {
        ...olds,
        privateClusterConfig: {
          ...olds.privateClusterConfig,
          enablePrivateEndpoint: true,
          masterGlobalAccessConfig: { enabled: true },
        },
      },
    } as never);
    expect(endpointOnly).toBeUndefined();

    const secondaryRanges = yield* provider.diff!({
      ...input,
      news: {
        ...olds,
        ipAllocationPolicy: {
          ...olds.ipAllocationPolicy,
          clusterSecondaryRangeName: "pods-b",
        },
      },
    } as never);
    expect(secondaryRanges).toEqual({
      action: "replace",
      deleteFirst: true,
    });
  }),
);

test.provider(
  "does not replace on node shape when the default pool is gone",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(GCP.Container.Cluster);
      const olds: GCP.Container.ClusterProps = {
        clusterId: "app",
        location: "us-central1-a",
        machineType: "e2-medium",
        initialNodeCount: 1,
        removeDefaultNodePool: true,
      };
      const input = {
        id: "App",
        fqn: "App",
        instanceId: "instance",
        olds,
        oldBindings: [],
        newBindings: [],
        output: { clusterId: "app", location: "us-central1-a" },
      } as const;
      const diff = yield* provider.diff!({
        ...input,
        news: {
          ...olds,
          machineType: "e2-standard-4",
          initialNodeCount: 3,
          spot: true,
        },
      } as never);
      expect(diff).toBeUndefined();

      // GKE only creates default-pool at cluster creation, so restoring it
      // can only be honored by a replacement.
      const restored = yield* provider.diff!({
        ...input,
        news: { ...olds, removeDefaultNodePool: false },
      } as never);
      expect(restored).toMatchObject({ action: "replace" });
    }),
);

test.provider("blocks replacement when deletion protection is enabled", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(GCP.Container.Cluster);
    const olds: GCP.Container.ClusterProps = {
      clusterId: "app",
      location: "us-central1-a",
      deletionProtection: true,
    };
    const error = yield* provider.diff!({
      id: "App",
      fqn: "App",
      instanceId: "instance",
      olds,
      oldBindings: [],
      newBindings: [],
      output: {
        name: "projects/project/locations/us-central1-a/clusters/app",
        clusterId: "app",
        location: "us-central1-a",
      },
      news: { ...olds, location: "us-central1-b" },
    } as never).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "GCP.Container.ClusterDeletionProtected",
      name: "projects/project/locations/us-central1-a/clusters/app",
    });
  }),
);

test.provider(
  "blocks ordinary deletion when deletion protection is enabled",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(GCP.Container.Cluster);
      const error = yield* provider.delete!({
        olds: { deletionProtection: true },
        output: {
          name: "projects/project/locations/us-central1-a/clusters/app",
        },
        force: false,
      } as never).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "GCP.Container.ClusterDeletionProtected",
        name: "projects/project/locations/us-central1-a/clusters/app",
      });
    }),
);

test.provider.skipIf(!hasGcpCreds)(
  "lists clusters and treats a missing cluster as NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = process.env.GOOGLE_PROJECT_ID!;
      const page = yield* container.listProjectsLocationsClusters({
        parent: `projects/${project}/locations/-`,
      });
      expect(Array.isArray(page.clusters ?? [])).toEqual(true);

      const missing = yield* container
        .getProjectsLocationsClusters({
          name: `projects/${project}/locations/us-central1-a/clusters/alchemy-missing-cluster`,
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

test.provider.skipIf(!hasGcpCreds)(
  "registers the gcp-gke kubernetes adapter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const adapter = yield* findClusterAdapter("gcp-gke");
      expect(adapter.kind).toEqual("Kubernetes.ClusterAdapter");
      expect(adapter.identity).toBeDefined();
      expect(adapter.registry).toBeDefined();
      expect(adapter.bootstrap).toBeDefined();
      expect(adapter.loadBalancerDefaults).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Container.Cluster("App", {
            location: "us-central1-a",
            machineType: "e2-medium",
            initialNodeCount: 1,
            diskSizeGb: 20,
            spot: true,
            description: "alchemy-test-cluster",
            labels: { env: "test" },
            ipAllocationPolicy: { useIpAliases: true },
            enableShieldedNodes: true,
            addonsConfig: {
              horizontalPodAutoscaling: { disabled: false },
            },
            costManagementConfig: { enabled: true },
            loggingConfig: {
              componentConfig: { enableComponents: ["SYSTEM_COMPONENTS"] },
            },
            monitoringConfig: {
              componentConfig: { enableComponents: ["SYSTEM_COMPONENTS"] },
              managedPrometheusConfig: { enabled: true },
            },
            removeDefaultNodePool: true,
          });
        }),
      );

      expect(created.name).toContain("/clusters/");
      expect(created.clusterId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1-a");
      expect(created.description).toEqual("alchemy-test-cluster");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.status).toEqual("RUNNING");
      expect(created.autopilot).toEqual(false);
      expect(created.endpoint).toEqual(expect.stringMatching(/^https:\/\//));
      expect(created.certificateAuthorityData).toEqual(expect.any(String));
      expect(created.connection.auth.kind).toEqual("gcp-gke");
      if (created.connection.auth.kind === "gcp-gke") {
        expect(created.connection.auth.clusterId).toEqual(created.clusterId);
      }
      expect(created.kubernetesObjects).toEqual([]);
      expect(created.workloadPool).toEqual(
        `${process.env.GOOGLE_PROJECT_ID}.svc.id.goog`,
      );
      expect(created.ipAllocationPolicy?.useIpAliases).toEqual(true);
      expect(created.enableShieldedNodes).toEqual(true);
      // GKE omits proto3 defaults, so an enabled addon reports no `disabled`.
      expect(
        created.addonsConfig?.horizontalPodAutoscaling?.disabled ?? false,
      ).toEqual(false);
      expect(created.costManagementConfig?.enabled).toEqual(true);
      expect(
        created.loggingConfig?.componentConfig?.enableComponents,
      ).toContain("SYSTEM_COMPONENTS");
      expect(
        created.monitoringConfig?.componentConfig?.enableComponents,
      ).toContain("SYSTEM_COMPONENTS");
      expect(
        created.monitoringConfig?.managedPrometheusConfig?.enabled,
      ).toEqual(true);

      const fetched = yield* container.getProjectsLocationsClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.clusterId);
      expect(fetched.resourceLabels?.env).toEqual("test");
      expect(fetched.description).toEqual("alchemy-test-cluster");
      expect(fetched.status).toEqual("RUNNING");
      expect(fetched.shieldedNodes?.enabled).toEqual(true);
      expect(fetched.costManagementConfig?.enabled).toEqual(true);

      const defaultPool = yield* container
        .getProjectsLocationsClustersNodePools({
          name: `${created.name}/nodePools/default-pool`,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(defaultPool).toEqual("gone");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Container.Cluster("App", {
            clusterId: created.clusterId,
            location: "us-central1-a",
            machineType: "e2-medium",
            initialNodeCount: 1,
            diskSizeGb: 20,
            spot: true,
            description: "alchemy-test-cluster",
            // Flip logging off in place so the setLogging branch runs
            // (`loggingConfig` is dropped here — it conflicts with "none").
            loggingService: "none",
            monitoringConfig: {
              componentConfig: { enableComponents: ["SYSTEM_COMPONENTS"] },
              managedPrometheusConfig: { enabled: true },
            },
            labels: { env: "prod", role: "k8s" },
            ipAllocationPolicy: { useIpAliases: true },
            enableShieldedNodes: true,
            addonsConfig: {
              horizontalPodAutoscaling: { disabled: false },
            },
            costManagementConfig: { enabled: true },
            removeDefaultNodePool: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.clusterUid).toEqual(created.clusterUid);
      expect(updated.labels).toMatchObject({ env: "prod", role: "k8s" });
      expect(updated.loggingService).toEqual("none");

      const refetched = yield* container.getProjectsLocationsClusters({
        name: created.name,
      });
      expect(refetched.resourceLabels?.env).toEqual("prod");
      expect(refetched.resourceLabels?.role).toEqual("k8s");
      expect(refetched.loggingService).toEqual("none");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Gated behind GCP_TEST_GKE: a cluster takes several minutes to provision
  // and each control-plane update is its own multi-minute operation.
  { timeout: 1_800_000 },
);
