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

const waitUntilGone = (driveId: string) =>
  drive.getDrives({ driveId }).pipe(
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
  "getDrives on a missing shared drive fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.getDrives({
          driveId: "alchemyMissingDriveId0000000000",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DRIVE)(
  "createDrives without shared-drive access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.createDrives({
          requestId: "alchemy-drive-probe",
          body: { name: "Alchemy Drive Probe" },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a shared drive",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drive.Drive("Team", {
            name: "Engineering",
          });
        }),
      );

      expect(created.driveId.length).toBeGreaterThan(0);
      expect(created.name).toEqual("Engineering");

      const fetched = yield* drive.getDrives({
        driveId: created.driveId,
      });
      expect(fetched.id).toEqual(created.driveId);
      expect(fetched.name).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drive.Drive("Team", {
            driveId: created.driveId,
            name: "Platform",
            restrictions: { driveMembersOnly: true },
          });
        }),
      );

      expect(updated.driveId).toEqual(created.driveId);
      expect(updated.name).toEqual("Platform");
      expect(updated.restrictions?.driveMembersOnly).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.driveId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
