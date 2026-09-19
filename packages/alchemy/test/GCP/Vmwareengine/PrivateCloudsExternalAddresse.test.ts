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
  vmwareengine
    .getProjectsLocationsPrivateCloudsExternalAddresses({ name })
    .pipe(
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
  "getProjectsLocationsPrivateCloudsExternalAddresses on a missing address fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsPrivateCloudsExternalAddresses({
          name: `projects/${project}/locations/us-central1-a/privateClouds/alchemy-missing/externalAddresses/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_VMWAREENGINE)(
  "createProjectsLocationsPrivateCloudsExternalAddresses without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.createProjectsLocationsPrivateCloudsExternalAddresses({
          parent: `projects/${project}/locations/us-central1-a/privateClouds/alchemy-missing`,
          externalAddressId: "alchemy-ea-probe",
          validateOnly: true,
          body: {
            internalIp: "192.168.1.10",
            description: "alchemy probe",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an external address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "address grandparent",
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
            description: "address parent",
          });
          const address = yield* GCP.Vmwareengine.PrivateCloudsExternalAddresse(
            "Web",
            {
              privateCloud: cloud.name,
              internalIp: "192.168.1.10",
              description: "alchemy-test-ea",
            },
          );
          return { ven, cloud, address };
        }),
      );

      expect(created.address.name).toContain("/externalAddresses/");
      expect(created.address.internalIp).toEqual("192.168.1.10");
      expect(created.address.description).toEqual("alchemy-test-ea");

      const fetched =
        yield* vmwareengine.getProjectsLocationsPrivateCloudsExternalAddresses({
          name: created.address.name,
        });
      expect(fetched.name).toEqual(created.address.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-ea");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "address grandparent",
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
            description: "address parent",
          });
          const address = yield* GCP.Vmwareengine.PrivateCloudsExternalAddresse(
            "Web",
            {
              privateCloud: cloud.name,
              externalAddressId: created.address.externalAddressId,
              internalIp: "192.168.1.11",
              description: "alchemy-prod-ea",
            },
          );
          return { ven, cloud, address };
        }),
      );

      expect(updated.address.name).toEqual(created.address.name);
      expect(updated.address.internalIp).toEqual("192.168.1.11");
      expect(updated.address.description).toEqual("alchemy-prod-ea");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.address.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
