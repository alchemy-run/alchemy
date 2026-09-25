import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkeonprem from "@distilled.cloud/gcp/gkeonprem_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  createErrorTags,
  hasGcpCreds,
  missingMembership,
  project,
  runLifecycle,
  vmwareControlPlane,
  vmwareLoadBalancer,
  vmwareNetwork,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  gkeonprem.getProjectsLocationsVmwareClusters({ name }).pipe(
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
  "getProjectsLocationsVmwareClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkeonprem.getProjectsLocationsVmwareClusters({
          name: `projects/${project}/locations/us-central1/vmwareClusters/alchemy-missing-vmc`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* gkeonprem
        .listProjectsLocationsVmwareClusters({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ vmwareClusters: [] as const }),
          ),
        );
      expect(Array.isArray(page.vmwareClusters ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GKEONPREM)(
  "create without an admin cluster is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Gkeonprem.VmwareCluster("Workload", {
              adminClusterMembership: missingMembership(project),
              onPremVersion: "1.28.0-gke.1",
              controlPlaneNode: vmwareControlPlane,
              networkConfig: vmwareNetwork,
              loadBalancer: vmwareLoadBalancer,
              description: "alchemy-test-vmc",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(createErrorTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a vmware cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gkeonprem.VmwareCluster("Workload", {
            adminClusterMembership: missingMembership(project),
            onPremVersion: "1.28.0-gke.1",
            controlPlaneNode: vmwareControlPlane,
            networkConfig: vmwareNetwork,
            loadBalancer: vmwareLoadBalancer,
            description: "alchemy-test-vmc",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/vmwareClusters/");
      expect(created.description).toEqual("alchemy-test-vmc");
      expect(created.labels.env).toEqual("test");

      const fetched = yield* gkeonprem.getProjectsLocationsVmwareClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-vmc");
      expect(fetched.annotations?.["alchemy-id"]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gkeonprem.VmwareCluster("Workload", {
            vmwareClusterId: created.vmwareClusterId,
            location: created.location,
            adminClusterMembership:
              created.adminClusterMembership ?? missingMembership(project),
            onPremVersion: created.onPremVersion ?? "1.28.0-gke.1",
            controlPlaneNode: created.controlPlaneNode ?? vmwareControlPlane,
            networkConfig: created.networkConfig ?? vmwareNetwork,
            loadBalancer: created.loadBalancer ?? vmwareLoadBalancer,
            description: "alchemy-test-vmc-v2",
            labels: { env: "test", team: "platform" },
          });
        }),
      );

      expect(updated.description).toEqual("alchemy-test-vmc-v2");
      expect(updated.labels.team).toEqual("platform");
      expect(updated.vmwareClusterId).toEqual(created.vmwareClusterId);

      yield* stack.destroy();
      yield* waitUntilGone(created.name);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
