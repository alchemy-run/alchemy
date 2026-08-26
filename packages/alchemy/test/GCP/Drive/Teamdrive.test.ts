import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as drive from "@distilled.cloud/gcp/drive_v3";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_DRIVE;

const waitUntilGone = (teamDriveId: string) =>
  drive.getTeamdrives({ teamDriveId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getTeamdrives on a missing Team Drive fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.getTeamdrives({
          teamDriveId: "alchemyMissingTeamDriveId000000",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DRIVE)(
  "createTeamdrives without shared-drive access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.createTeamdrives({
          requestId: "alchemy-teamdrive-probe",
          body: { name: "Alchemy Teamdrive Probe" },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a Team Drive",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drive.Teamdrive("Legacy", {
            name: "Archives",
          });
        }),
      );

      expect(created.teamDriveId.length).toBeGreaterThan(0);
      expect(created.name).toEqual("Archives");

      const fetched = yield* drive.getTeamdrives({
        teamDriveId: created.teamDriveId,
      });
      expect(fetched.id).toEqual(created.teamDriveId);
      expect(fetched.name).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drive.Teamdrive("Legacy", {
            teamDriveId: created.teamDriveId,
            name: "Cold storage",
          });
        }),
      );

      expect(updated.teamDriveId).toEqual(created.teamDriveId);
      expect(updated.name).toEqual("Cold storage");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.teamDriveId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
