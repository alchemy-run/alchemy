import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_VMWAREENGINE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  vmwareengine.getProjectsLocationsPrivateCloudsClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsPrivateCloudsClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsPrivateCloudsClusters({
          name: `projects/${project}/locations/us-central1-a/privateClouds/alchemy-missing/clusters/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_VMWAREENGINE)(
  "createProjectsLocationsPrivateCloudsClusters without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.createProjectsLocationsPrivateCloudsClusters({
          parent: `projects/${project}/locations/us-central1-a/privateClouds/alchemy-missing`,
          clusterId: "alchemy-cl-probe",
          validateOnly: true,
          body: {
            nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a private cloud cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "cluster grandparent",
          });
          const cloud = yield* GCP.Vmwareengine.PrivateCloud("Sddc", {
            location: "us-central1-a",
            networkConfig: {
              managementCidr: "192.168.1.0/24",
              vmwareEngineNetwork: ven.name,
            },
            managementCluster: {
              clusterId: "mgmt",
              nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
            },
            description: "cluster parent",
          });
          const cluster = yield* GCP.Vmwareengine.PrivateCloudsCluster("Work", {
            privateCloud: cloud.name,
            nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
          });
          return { ven, cloud, cluster };
        }),
      );

      expect(created.cluster.name).toContain("/clusters/");
      expect(created.cluster.management).toEqual(false);
      expect(created.cluster.privateCloud).toEqual(created.cloud.name);

      const fetched =
        yield* vmwareengine.getProjectsLocationsPrivateCloudsClusters({
          name: created.cluster.name,
        });
      expect(fetched.name).toEqual(created.cluster.name);
      expect(fetched.management).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "cluster grandparent",
          });
          const cloud = yield* GCP.Vmwareengine.PrivateCloud("Sddc", {
            privateCloudId: created.cloud.privateCloudId,
            location: "us-central1-a",
            networkConfig: {
              managementCidr: "192.168.1.0/24",
              vmwareEngineNetwork: ven.name,
            },
            managementCluster: {
              clusterId: "mgmt",
              nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
            },
            description: "cluster parent",
          });
          const cluster = yield* GCP.Vmwareengine.PrivateCloudsCluster("Work", {
            privateCloud: cloud.name,
            clusterId: created.cluster.clusterId,
            nodeTypeConfigs: { "standard-72": { nodeCount: 4 } },
          });
          return { ven, cloud, cluster };
        }),
      );

      expect(updated.cluster.name).toEqual(created.cluster.name);
      expect(
        updated.cluster.nodeTypeConfigs?.["standard-72"]?.nodeCount,
      ).toEqual(4);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.cluster.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
