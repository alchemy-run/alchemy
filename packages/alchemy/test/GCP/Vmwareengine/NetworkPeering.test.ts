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
  vmwareengine.getProjectsLocationsNetworkPeerings({ name }).pipe(
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
  "getProjectsLocationsNetworkPeerings on a missing peering fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsNetworkPeerings({
          name: `projects/${project}/locations/global/networkPeerings/alchemy-np-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* vmwareengine
        .listProjectsLocationsNetworkPeerings({
          parent: `projects/${project}/locations/global`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ networkPeerings: [] as const }),
          ),
        );
      expect(Array.isArray(page.networkPeerings ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_VMWAREENGINE)(
  "createProjectsLocationsNetworkPeerings without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.createProjectsLocationsNetworkPeerings({
          parent: `projects/${project}/locations/global`,
          networkPeeringId: "alchemy-np-probe",
          validateOnly: true,
          body: {
            peerNetwork: `projects/${project}/global/networks/default`,
            peerNetworkType: "STANDARD",
            vmwareEngineNetwork: `projects/${project}/locations/global/vmwareEngineNetworks/alchemy-ven-probe`,
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
  "create, update, and delete a network peering",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "peering parent",
          });
          const peering = yield* GCP.Vmwareengine.NetworkPeering("ToVpc", {
            vmwareEngineNetwork: ven.name,
            peerNetwork: `projects/${project}/global/networks/default`,
            peerNetworkType: "STANDARD",
            description: "alchemy-test-peering",
          });
          return { ven, peering };
        }),
      );

      expect(created.peering.name).toContain("/networkPeerings/");
      expect(created.peering.location).toEqual("global");
      expect(created.peering.description).toEqual("alchemy-test-peering");

      const fetched = yield* vmwareengine.getProjectsLocationsNetworkPeerings({
        name: created.peering.name,
      });
      expect(fetched.name).toEqual(created.peering.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-peering");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "peering parent",
          });
          const peering = yield* GCP.Vmwareengine.NetworkPeering("ToVpc", {
            networkPeeringId: created.peering.networkPeeringId,
            vmwareEngineNetwork: ven.name,
            peerNetwork: `projects/${project}/global/networks/default`,
            peerNetworkType: "STANDARD",
            description: "alchemy-prod-peering",
          });
          return { ven, peering };
        }),
      );

      expect(updated.peering.name).toEqual(created.peering.name);
      expect(updated.peering.description).toEqual("alchemy-prod-peering");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.peering.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
