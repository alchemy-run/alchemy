import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import type { StackServices } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { TestInstance } from "./fixtures/test-instance.ts";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<GCP.ProviderRequirements, never, StackServices>,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The lifecycle creates its own instance (5-10 minutes), so `--fast` skips it.
const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  sqladmin.getBackupBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    // Cloud SQL answers a deleted backup uid with this 403.
    Effect.catchTag("SqlBackupAccessDenied", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getBackupBackups on a missing backup fails with SqlBackupAccessDenied",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getBackupBackups({
          name: `projects/${project}/backups/00000000-0000-0000-0000-000000000000`,
        }),
      );
      // Cloud SQL hides unknown backups behind 403 rather than 404.
      expect(error._tag).toBe("SqlBackupAccessDenied");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider(
  "lists sql backups",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const page = yield* sqladmin.listBackupsBackups({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect((page.backups ?? []).map((backup) => backup.name)).not.toContain(
        `projects/${project}/backups/00000000-0000-0000-0000-000000000000`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql backup",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const { instanceName: instance } = yield* stack.deploy(TestInstance);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          // Depend on the instance so destroy removes this first.
          const db = yield* TestInstance;
          return yield* GCP.SQL.Backup("Nightly", {
            instance: db.instanceName,
            description: "alchemy-on-demand",
          });
        }),
      );

      expect(created.backupId).toEqual(expect.any(String));
      expect(created.backupId.length).toBeGreaterThan(0);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(`projects/${project}/backups/${created.backupId}`);
      expect(created.description).toEqual("alchemy-on-demand");

      const fetched = yield* sqladmin.getBackupBackups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.instance).toEqual(instance);
      expect(fetched.description).toContain("alchemy-on-demand");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          // Depend on the instance so destroy removes this first.
          const db = yield* TestInstance;
          return yield* GCP.SQL.Backup("Nightly", {
            instance: db.instanceName,
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
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 1_800_000 },
);
