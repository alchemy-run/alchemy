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

const waitUntilGone = (fileId: string) =>
  drive
    .getFiles({
      fileId,
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
  "getFiles on a missing file fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.getFiles({
          fileId: "alchemyMissingFileId000000000000",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DRIVE)(
  "createFiles without Drive access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.createFiles({
          body: { name: "Alchemy Drive Probe" },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a file",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drive.File("Notes", {
            name: "sprint-notes",
            description: "weekly notes",
            properties: { env: "test" },
          });
        }),
      );

      expect(created.fileId.length).toBeGreaterThan(0);
      expect(created.name).toEqual("sprint-notes");
      expect(created.description).toEqual("weekly notes");
      expect(created.properties).toMatchObject({ env: "test" });
      expect(created.starred).toEqual(false);

      const fetched = yield* drive.getFiles({
        fileId: created.fileId,
        supportsAllDrives: true,
      });
      expect(fetched.id).toEqual(created.fileId);
      expect(fetched.properties?.alchemy).toEqual("true");
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Drive.File("Notes", {
            fileId: created.fileId,
            name: "sprint-notes-2026",
            description: "weekly notes",
            starred: true,
            properties: { env: "prod" },
          });
        }),
      );

      expect(updated.fileId).toEqual(created.fileId);
      expect(updated.name).toEqual("sprint-notes-2026");
      expect(updated.starred).toEqual(true);
      expect(updated.properties).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.fileId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
