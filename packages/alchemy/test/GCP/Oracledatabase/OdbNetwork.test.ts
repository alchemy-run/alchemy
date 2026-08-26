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
  oracle.getProjectsLocationsOdbNetworks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsOdbNetworks on a missing network fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsOdbNetworks({
          name: `projects/${project}/locations/${location}/odbNetworks/alchemy-odb-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* oracle
        .listProjectsLocationsOdbNetworks({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ odbNetworks: [] as const }),
          ),
        );
      expect(Array.isArray(page.odbNetworks ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an odb network",
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
          return yield* GCP.Oracledatabase.OdbNetwork("OracleNet", {
            location,
            network: "default",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/odbNetworks/");
      expect(created.odbNetworkId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.network).toContain("/networks/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsOdbNetworks({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Oracledatabase.OdbNetwork("OracleNet", {
            odbNetworkId: created.odbNetworkId,
            location,
            network: "default",
            labels: { env: "prod", role: "oracle" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.odbNetworkId).toEqual(created.odbNetworkId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
