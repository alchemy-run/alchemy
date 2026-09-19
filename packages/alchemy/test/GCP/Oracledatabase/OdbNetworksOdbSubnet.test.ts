import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
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

const runLifecycle = hasGcpCreds && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  oracle.getProjectsLocationsOdbNetworksOdbSubnets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsOdbNetworksOdbSubnets on a missing subnet fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsOdbNetworksOdbSubnets({
          name: `projects/${project}/locations/${location}/odbNetworks/alchemy-odb-missing/odbSubnets/alchemy-subnet-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an odb subnet",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsOdbNetworks({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const net = yield* GCP.Oracledatabase.OdbNetwork("OracleNet", {
            location,
            network: "default",
            labels: { env: "test" },
          });
          const subnet = yield* GCP.Oracledatabase.OdbNetworksOdbSubnet(
            "Client",
            {
              odbNetwork: net.name,
              location,
              cidrRange: "10.250.0.0/27",
              purpose: "CLIENT_SUBNET",
              labels: { env: "test" },
            },
          );
          return { net, subnet };
        }),
      );

      expect(created.subnet.name).toContain("/odbSubnets/");
      expect(created.subnet.odbSubnetId).toEqual(expect.any(String));
      expect(created.subnet.odbNetwork).toEqual(created.net.name);
      expect(created.subnet.cidrRange).toEqual("10.250.0.0/27");
      expect(created.subnet.purpose).toEqual("CLIENT_SUBNET");
      expect(created.subnet.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsOdbNetworksOdbSubnets({
        name: created.subnet.name,
      });
      expect(fetched.name).toEqual(created.subnet.name);
      expect(fetched.cidrRange).toEqual("10.250.0.0/27");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const net = yield* GCP.Oracledatabase.OdbNetwork("OracleNet", {
            odbNetworkId: created.net.odbNetworkId,
            location,
            network: "default",
            labels: { env: "prod" },
          });
          const subnet = yield* GCP.Oracledatabase.OdbNetworksOdbSubnet(
            "Client",
            {
              odbNetwork: net.name,
              odbSubnetId: created.subnet.odbSubnetId,
              location,
              cidrRange: "10.250.0.0/27",
              purpose: "CLIENT_SUBNET",
              labels: { env: "prod", role: "client" },
            },
          );
          return { net, subnet };
        }),
      );

      expect(updated.subnet.name).toEqual(created.subnet.name);
      expect(updated.subnet.odbSubnetId).toEqual(created.subnet.odbSubnetId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subnet.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
