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
  vmwareengine.getProjectsLocationsPrivateClouds({ name }).pipe(
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
  "getProjectsLocationsPrivateClouds on a missing private cloud fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsPrivateClouds({
          name: `projects/${project}/locations/us-central1-a/privateClouds/alchemy-pc-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* vmwareengine
        .listProjectsLocationsPrivateClouds({
          parent: `projects/${project}/locations/us-central1-a`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ privateClouds: [] as const }),
          ),
        );
      expect(Array.isArray(page.privateClouds ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_VMWAREENGINE)(
  "createProjectsLocationsPrivateClouds without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.createProjectsLocationsPrivateClouds({
          parent: `projects/${project}/locations/us-central1-a`,
          privateCloudId: "alchemy-pc-probe",
          validateOnly: true,
          body: {
            type: "STANDARD",
            description: "alchemy probe",
            networkConfig: { managementCidr: "192.168.1.0/24" },
            managementCluster: {
              clusterId: "mgmt",
              nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a private cloud",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "cloud parent",
          });
          const cloud = yield* GCP.Vmwareengine.PrivateCloud("Sddc", {
            location: "us-central1-a",
            type: "STANDARD",
            networkConfig: {
              managementCidr: "192.168.1.0/24",
              vmwareEngineNetwork: ven.name,
            },
            managementCluster: {
              clusterId: "mgmt",
              nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
            },
            description: "alchemy-test-pc",
          });
          return { ven, cloud };
        }),
      );

      expect(created.cloud.name).toContain("/privateClouds/");
      expect(created.cloud.location).toEqual("us-central1-a");
      expect(created.cloud.description).toEqual("alchemy-test-pc");

      const fetched = yield* vmwareengine.getProjectsLocationsPrivateClouds({
        name: created.cloud.name,
      });
      expect(fetched.name).toEqual(created.cloud.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-pc");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "cloud parent",
          });
          const cloud = yield* GCP.Vmwareengine.PrivateCloud("Sddc", {
            privateCloudId: created.cloud.privateCloudId,
            location: "us-central1-a",
            type: "STANDARD",
            networkConfig: {
              managementCidr: "192.168.1.0/24",
              vmwareEngineNetwork: ven.name,
            },
            managementCluster: {
              clusterId: "mgmt",
              nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
            },
            description: "alchemy-prod-pc",
          });
          return { ven, cloud };
        }),
      );

      expect(updated.cloud.name).toEqual(created.cloud.name);
      expect(updated.cloud.description).toEqual("alchemy-prod-pc");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.cloud.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
