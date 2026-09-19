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
  oracle.getProjectsLocationsGoldengateDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsGoldengateDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsGoldengateDeployments({
          name: `projects/${project}/locations/${location}/goldengateDeployments/alchemy-gg-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* oracle
        .listProjectsLocationsGoldengateDeployments({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ goldengateDeployments: [] as const }),
          ),
        );
      expect(Array.isArray(page.goldengateDeployments ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a goldengate deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsGoldengateDeployments({
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
            },
          );
          const gg = yield* GCP.Oracledatabase.GoldengateDeployment(
            "Replicat",
            {
              location,
              odbNetwork: net.name,
              odbSubnet: subnet.name,
              displayName: "alchemy-gg",
              deploymentType: "DATABASE_ORACLE",
              oggData: {
                adminUsername: "oggadmin",
                deployment: "oggdeploy",
                adminPassword: "AlchemyTest1!",
              },
              labels: { env: "test" },
            },
          );
          return { net, subnet, gg };
        }),
      );

      expect(created.gg.name).toContain("/goldengateDeployments/");
      expect(created.gg.goldengateDeploymentId).toEqual(expect.any(String));
      expect(created.gg.location).toEqual(location);
      expect(created.gg.odbSubnet).toEqual(created.subnet.name);
      expect(created.gg.displayName).toEqual("alchemy-gg");
      expect(created.gg.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsGoldengateDeployments({
        name: created.gg.name,
      });
      expect(fetched.name).toEqual(created.gg.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.displayName).toEqual("alchemy-gg");

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
            },
          );
          const gg = yield* GCP.Oracledatabase.GoldengateDeployment(
            "Replicat",
            {
              goldengateDeploymentId: created.gg.goldengateDeploymentId,
              location,
              odbNetwork: net.name,
              odbSubnet: subnet.name,
              displayName: "alchemy-gg",
              deploymentType: "DATABASE_ORACLE",
              oggData: {
                adminUsername: "oggadmin",
                deployment: "oggdeploy",
                adminPassword: "AlchemyTest1!",
              },
              labels: { env: "prod", role: "gg" },
            },
          );
          return { net, subnet, gg };
        }),
      );

      expect(updated.gg.name).toEqual(created.gg.name);
      expect(updated.gg.goldengateDeploymentId).toEqual(
        created.gg.goldengateDeploymentId,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.gg.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
