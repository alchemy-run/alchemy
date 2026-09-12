import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkeonprem from "@distilled.cloud/gcp/gkeonprem_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  bareMetalControlPlane,
  bareMetalLoadBalancer,
  bareMetalNetwork,
  bareMetalStorage,
  createErrorTags,
  hasGcpCreds,
  missingMembership,
  project,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  gkeonprem.getProjectsLocationsBareMetalClusters({ name }).pipe(
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
  "getProjectsLocationsBareMetalClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkeonprem.getProjectsLocationsBareMetalClusters({
          name: `projects/${project}/locations/us-central1/bareMetalClusters/alchemy-missing-bmc`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* gkeonprem
        .listProjectsLocationsBareMetalClusters({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ bareMetalClusters: [] as const }),
          ),
        );
      expect(Array.isArray(page.bareMetalClusters ?? [])).toEqual(true);

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
            return yield* GCP.Gkeonprem.BareMetalCluster("Workload", {
              adminClusterMembership: missingMembership(project),
              bareMetalVersion: "1.28.0-gke.1",
              controlPlane: bareMetalControlPlane,
              storage: bareMetalStorage,
              networkConfig: bareMetalNetwork,
              loadBalancer: bareMetalLoadBalancer,
              description: "alchemy-test-bmc",
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
  "create, update, and delete a bare metal cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gkeonprem.BareMetalCluster("Workload", {
            adminClusterMembership: missingMembership(project),
            bareMetalVersion: "1.28.0-gke.1",
            controlPlane: bareMetalControlPlane,
            storage: bareMetalStorage,
            networkConfig: bareMetalNetwork,
            loadBalancer: bareMetalLoadBalancer,
            description: "alchemy-test-bmc",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/bareMetalClusters/");
      expect(created.description).toEqual("alchemy-test-bmc");
      expect(created.labels.env).toEqual("test");

      const fetched = yield* gkeonprem.getProjectsLocationsBareMetalClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-bmc");
      expect(fetched.annotations?.["alchemy-id"]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gkeonprem.BareMetalCluster("Workload", {
            bareMetalClusterId: created.bareMetalClusterId,
            location: created.location,
            adminClusterMembership:
              created.adminClusterMembership ?? missingMembership(project),
            bareMetalVersion: created.bareMetalVersion ?? "1.28.0-gke.1",
            controlPlane: created.controlPlane ?? bareMetalControlPlane,
            storage: created.storage ?? bareMetalStorage,
            networkConfig: created.networkConfig ?? bareMetalNetwork,
            loadBalancer: created.loadBalancer ?? bareMetalLoadBalancer,
            description: "alchemy-test-bmc-v2",
            labels: { env: "test", team: "platform" },
          });
        }),
      );

      expect(updated.description).toEqual("alchemy-test-bmc-v2");
      expect(updated.labels.team).toEqual("platform");
      expect(updated.bareMetalClusterId).toEqual(created.bareMetalClusterId);

      yield* stack.destroy();
      yield* waitUntilGone(created.name);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
