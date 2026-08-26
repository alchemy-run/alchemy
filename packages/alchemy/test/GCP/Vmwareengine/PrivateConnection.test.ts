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
const serviceNetwork =
  process.env.GCP_TEST_VMWAREENGINE_SERVICE_NETWORK ??
  `projects/${project}/global/networks/default`;

const waitUntilGone = (name: string) =>
  vmwareengine.getProjectsLocationsPrivateConnections({ name }).pipe(
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
  "getProjectsLocationsPrivateConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsPrivateConnections({
          name: `projects/${project}/locations/us-central1/privateConnections/alchemy-pc-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* vmwareengine
        .listProjectsLocationsPrivateConnections({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ privateConnections: [] as const }),
          ),
        );
      expect(Array.isArray(page.privateConnections ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_VMWAREENGINE)(
  "createProjectsLocationsPrivateConnections without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.createProjectsLocationsPrivateConnections({
          parent: `projects/${project}/locations/us-central1`,
          privateConnectionId: "alchemy-pc-probe",
          validateOnly: true,
          body: {
            type: "THIRD_PARTY_SERVICE",
            vmwareEngineNetwork: `projects/${project}/locations/global/vmwareEngineNetworks/alchemy-ven-missing`,
            serviceNetwork,
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
  "create, update, and delete a private connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "alchemy-test-pc-ven",
          });
          const connection = yield* GCP.Vmwareengine.PrivateConnection("Peer", {
            location: "us-central1",
            type: "THIRD_PARTY_SERVICE",
            vmwareEngineNetwork: ven.name,
            serviceNetwork,
            description: "alchemy-test-pc",
          });
          return { ven, connection };
        }),
      );

      expect(created.connection.name).toContain("/privateConnections/");
      expect(created.connection.location).toEqual("us-central1");
      expect(created.connection.type).toEqual("THIRD_PARTY_SERVICE");
      expect(created.connection.description).toEqual("alchemy-test-pc");
      expect(created.connection.vmwareEngineNetwork).toEqual(created.ven.name);
      expect(created.connection.createTime).toEqual(expect.any(String));

      const fetched =
        yield* vmwareengine.getProjectsLocationsPrivateConnections({
          name: created.connection.name,
        });
      expect(fetched.name).toEqual(created.connection.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-pc");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.Vmwareengine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            location: "global",
            type: "STANDARD",
            description: "alchemy-test-pc-ven",
          });
          const connection = yield* GCP.Vmwareengine.PrivateConnection("Peer", {
            privateConnectionId: created.connection.privateConnectionId,
            location: "us-central1",
            type: "THIRD_PARTY_SERVICE",
            vmwareEngineNetwork: ven.name,
            serviceNetwork,
            description: "alchemy-prod-pc",
          });
          return { ven, connection };
        }),
      );

      expect(updated.connection.name).toEqual(created.connection.name);
      expect(updated.connection.description).toEqual("alchemy-prod-pc");

      const refetched =
        yield* vmwareengine.getProjectsLocationsPrivateConnections({
          name: created.connection.name,
        });
      expect(refetched.description).toContain("alchemy-prod-pc");
      expect(refetched.description).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.connection.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
