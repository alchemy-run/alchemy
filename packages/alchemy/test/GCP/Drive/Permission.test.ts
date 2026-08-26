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

const waitUntilGone = (fileId: string, permissionId: string) =>
  drive
    .getPermissions({
      fileId,
      permissionId,
      supportsAllDrives: true,
    })
    .pipe(
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
  "getPermissions on a missing permission fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.getPermissions({
          fileId: "alchemyMissingFileId000000000000",
          permissionId: "anyoneWithLink",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DRIVE)(
  "createPermissions without Drive access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.createPermissions({
          fileId: "alchemyMissingFileId000000000000",
          sendNotificationEmail: false,
          body: { type: "anyone", role: "reader" },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a permission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const file = yield* GCP.Drive.File("Doc", {
            name: "share-doc",
          });
          return yield* GCP.Drive.Permission("Public", {
            fileId: file.fileId,
            type: "anyone",
            role: "reader",
          });
        }),
      );

      expect(created.permissionId.length).toBeGreaterThan(0);
      expect(created.fileId.length).toBeGreaterThan(0);
      expect(created.type).toEqual("anyone");
      expect(created.role).toEqual("reader");

      const fetched = yield* drive.getPermissions({
        fileId: created.fileId,
        permissionId: created.permissionId,
        supportsAllDrives: true,
      });
      expect(fetched.id).toEqual(created.permissionId);
      expect(fetched.role).toEqual("reader");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const file = yield* GCP.Drive.File("Doc", {
            fileId: created.fileId,
            name: "share-doc",
          });
          return yield* GCP.Drive.Permission("Public", {
            fileId: file.fileId,
            permissionId: created.permissionId,
            type: "anyone",
            role: "commenter",
          });
        }),
      );

      expect(updated.permissionId).toEqual(created.permissionId);
      expect(updated.role).toEqual("commenter");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.fileId, created.permissionId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
