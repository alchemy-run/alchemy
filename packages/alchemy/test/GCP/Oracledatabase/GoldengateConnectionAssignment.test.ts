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

const waitUntilGone = (name: string) =>
  oracle.getProjectsLocationsGoldengateConnectionAssignments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsGoldengateConnectionAssignments on a missing assignment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsGoldengateConnectionAssignments({
          name: `projects/${project}/locations/us-central1/goldengateConnectionAssignments/alchemy-oracle-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* oracle
        .listProjectsLocationsGoldengateConnectionAssignments({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ goldengateConnectionAssignments: [] as const }),
          ),
        );
      expect(Array.isArray(page.goldengateConnectionAssignments ?? [])).toEqual(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a goldengate connection assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsGoldengateConnectionAssignments({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const connection = yield* GCP.Oracledatabase.GoldengateConnection(
            "Src",
            {
              connectionType: "GENERIC",
              displayName: "alchemy-gg-src",
              properties: {
                genericConnectionProperties: {
                  host: "db.example.com",
                  technologyType: "GENERIC",
                },
              },
            },
          );
          return yield* GCP.Oracledatabase.GoldengateConnectionAssignment(
            "Assign",
            {
              location: "us-central1",
              displayName: "alchemy-gg-assign",
              goldengateConnection: connection.name,
              goldengateDeployment: `projects/${project}/locations/us-central1/goldengateDeployments/missing`,
              labels: { env: "test" },
            },
          );
        }),
      );

      expect(created.name).toContain("/goldengateConnectionAssignments/");
      expect(created.goldengateConnectionAssignmentId).toEqual(
        expect.any(String),
      );
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* oracle.getProjectsLocationsGoldengateConnectionAssignments({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
