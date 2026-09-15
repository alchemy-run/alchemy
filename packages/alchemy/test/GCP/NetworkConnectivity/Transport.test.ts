import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_TRANSPORT;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-east4";
const remoteProfile = "aws-us-east-1";

const transportName = (id: string) =>
  `projects/${project}/locations/${location}/transports/${id}`;

const waitUntilGone = (name: string) =>
  networkconnectivity.getProjectsLocationsTransports({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeCreate = (transportId: string, profileId: string) =>
  networkconnectivity
    .createProjectsLocationsTransports({
      parent: `projects/${project}/locations/${location}`,
      transportId,
      body: {
        network: `projects/${project}/global/networks/default`,
        remoteProfile: `projects/${project}/locations/${location}/remoteTransportProfiles/${profileId}`,
        bandwidth: "BPS_1G",
        remoteAccountId: "123456789012",
        description: "alchemy transport probe",
      },
    })
    .pipe(Effect.result);

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsTransports on a missing transport fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsTransports({
          name: transportName("alchemy-tp-missing"),
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* networkconnectivity
        .listProjectsLocationsTransports({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ transports: [] as const }),
          ),
          Effect.catchTag("NotFound", () =>
            Effect.succeed({ transports: [] as const }),
          ),
        );
      expect(Array.isArray(page.transports ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createProjectsLocationsTransports with a missing remote profile fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* probeCreate(
        "alchemy-tp-probe",
        "aws-profile-missing",
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("NotFound");
        expect(result.failure.message ?? "").toContain(
          "remoteTransportProfiles/aws-profile-missing",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a transport",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("TransportVpc", {
            autoCreateSubnetworks: false,
          });
          const transport = yield* GCP.NetworkConnectivity.Transport("Aws", {
            location,
            network: network.selfLink.as<string>(),
            remoteProfile,
            bandwidth: "BPS_1G",
            remoteAccountId: "123456789012",
            advertisedRoutes: ["10.0.0.0/8"],
            description: "transport a",
            labels: { env: "test" },
          });
          return { network, transport };
        }),
      );

      expect(created.transport.name).toContain("/transports/");
      expect(created.transport.name).toContain(`/locations/${location}/`);
      expect(created.transport.transportId).toEqual(expect.any(String));
      expect(created.transport.location).toEqual(location);
      expect(created.transport.networkName).toEqual(
        created.network.networkName,
      );
      expect(created.transport.remoteProfileId).toEqual(remoteProfile);
      expect(created.transport.bandwidth).toEqual("BPS_1G");
      expect(created.transport.description).toEqual("transport a");
      expect(created.transport.labels).toMatchObject({ env: "test" });
      expect(created.transport.createTime).toEqual(expect.any(String));
      expect(["PENDING_KEY", "PENDING_CONFIG", "ACTIVE", "CREATING"]).toContain(
        created.transport.state,
      );

      const fetched = yield* networkconnectivity.getProjectsLocationsTransports(
        {
          name: created.transport.name,
        },
      );
      expect(fetched.name).toEqual(created.transport.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("transport a");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("TransportVpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const transport = yield* GCP.NetworkConnectivity.Transport("Aws", {
            transportId: created.transport.transportId,
            location,
            network: network.selfLink.as<string>(),
            remoteProfile,
            bandwidth: "BPS_1G",
            remoteAccountId: "123456789012",
            advertisedRoutes: ["10.0.0.0/8"],
            description: "transport b",
            labels: { env: "prod", role: "cci" },
          });
          return { network, transport };
        }),
      );

      expect(updated.transport.name).toEqual(created.transport.name);
      expect(updated.transport.transportId).toEqual(
        created.transport.transportId,
      );
      expect(updated.transport.description).toEqual("transport b");
      expect(updated.transport.labels).toMatchObject({
        env: "prod",
        role: "cci",
      });

      const refetched =
        yield* networkconnectivity.getProjectsLocationsTransports({
          name: created.transport.name,
        });
      expect(refetched.description).toEqual("transport b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("cci");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.transport.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
