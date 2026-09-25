import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<
    GCP.ProviderRequirements,
    never,
    StackServices
  >,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const sqlInstance =
  process.env.GCP_SQL_INSTANCE || process.env.GCP_TEST_SQL_INSTANCE;
const runLifecycle = hasGcpCreds && !!sqlInstance && !process.env.FAST;

const waitUntilGone = (name: string) =>
  sqladmin.getBackupBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getBackupBackups on a missing backup fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getBackupBackups({
          name: `projects/${project}/backups/00000000-0000-0000-0000-000000000000`,
        }),
      );
      // Cloud SQL hides unknown backups behind 403 rather than 404.
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "lists sql backups",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const page = yield* sqladmin.listBackupsBackups({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect(Array.isArray(page.backups ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const instance = sqlInstance!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.BackupBackup("Nightly", {
            instance,
            description: "alchemy-on-demand",
          });
        }),
      );

      expect(created.backupId).toEqual(expect.any(String));
      expect(created.backupId.length).toBeGreaterThan(0);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/backups/${created.backupId}`,
      );
      expect(created.description).toEqual("alchemy-on-demand");

      const fetched = yield* sqladmin.getBackupBackups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.instance).toEqual(instance);
      expect(fetched.description).toContain("alchemy-on-demand");
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.BackupBackup("Nightly", {
            instance,
            description: "alchemy-on-demand",
          });
        }),
      );

      expect(updated.backupId).toEqual(created.backupId);
      expect(updated.name).toEqual(created.name);

      const refetched = yield* sqladmin.getBackupBackups({
        name: updated.name,
      });
      expect(refetched.name).toEqual(updated.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
