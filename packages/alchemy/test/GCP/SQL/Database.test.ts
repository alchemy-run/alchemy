import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const sqlInstance =
  process.env.GCP_SQL_INSTANCE || process.env.GCP_TEST_SQL_INSTANCE;
const runLifecycle = hasGcpCreds && !!sqlInstance && !process.env.FAST;

const waitUntilGone = (instance: string, databaseName: string) =>
  sqladmin
    .getDatabases({
      project,
      instance,
      database: databaseName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getDatabases on a missing instance fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getDatabases({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
          database: "alchemy_db_does_not_exist",
        }),
      );
      // Cloud SQL hides unknown instances behind 403 rather than 404.
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "lists sql databases",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const page = yield* sqladmin.listInstances({
        project,
        maxResults: 10,
      });
      expect(Array.isArray(page.items ?? [])).toEqual(true);
      for (const instance of page.items ?? []) {
        if (!instance.name) continue;
        const databases = yield* sqladmin
          .listDatabases({
            project,
            instance: instance.name,
          })
          .pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed({ items: [] as sqladmin.DatabaseList }),
            ),
          );
        expect(Array.isArray(databases.items ?? [])).toEqual(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const instance = sqlInstance!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Database("App", {
            instance,
          });
        }),
      );

      expect(created.databaseName).toEqual(expect.any(String));
      expect(created.databaseName).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);

      const fetched = yield* sqladmin.getDatabases({
        project: created.project,
        instance: created.instance,
        database: created.databaseName,
      });
      expect(fetched.name).toEqual(created.databaseName);
      expect(fetched.instance).toEqual(created.instance);

      const live = yield* sqladmin.getInstances({
        project: created.project,
        instance: created.instance,
      });
      const isMysql = (live.databaseVersion ?? "")
        .toUpperCase()
        .startsWith("MYSQL");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Database("App", {
            instance,
            databaseName: created.databaseName,
            charset: isMysql ? "utf8mb4" : created.charset,
            collation: isMysql ? "utf8mb4_unicode_ci" : created.collation,
          });
        }),
      );

      expect(updated.databaseName).toEqual(created.databaseName);
      expect(updated.instance).toEqual(created.instance);
      if (isMysql) {
        expect(updated.charset?.toLowerCase()).toEqual("utf8mb4");
      }

      const refetched = yield* sqladmin.getDatabases({
        project: updated.project,
        instance: updated.instance,
        database: updated.databaseName,
      });
      expect(refetched.name).toEqual(updated.databaseName);
      if (isMysql) {
        expect(refetched.charset?.toLowerCase()).toEqual("utf8mb4");
      }

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.instance, created.databaseName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
