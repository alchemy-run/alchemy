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

const waitUntilGone = (
  instance: string,
  userName: string,
  host: string | undefined,
) =>
  sqladmin
    .getUsers({
      project,
      instance,
      name: userName,
      ...(host ? { host } : {}),
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
  "getUsers on a missing instance fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getUsers({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
          name: "alchemy_user_does_not_exist",
        }),
      );
      // Cloud SQL hides unknown instances behind 403 rather than 404.
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "lists sql users",
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
        const users = yield* sqladmin
          .listUsers({
            project,
            instance: instance.name,
          })
          .pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed({ items: [] as sqladmin.UserList }),
            ),
          );
        expect(Array.isArray(users.items ?? [])).toEqual(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const instance = sqlInstance!;
      const live = yield* sqladmin.getInstances({
        project,
        instance,
      });
      const isMysql = (live.databaseVersion ?? "")
        .toUpperCase()
        .startsWith("MYSQL");
      const host = isMysql ? "%" : undefined;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.User("AppUser", {
            instance,
            host,
            password: "Alchemy-test-pass-1",
          });
        }),
      );

      expect(created.userName).toEqual(expect.any(String));
      expect(created.userName).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);
      if (isMysql) {
        expect(created.host).toEqual("%");
      }

      const fetched = yield* sqladmin.getUsers({
        project: created.project,
        instance: created.instance,
        name: created.userName,
        ...(created.host ? { host: created.host } : {}),
      });
      expect(fetched.name).toEqual(created.userName);
      expect(fetched.instance).toEqual(created.instance);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.User("AppUser", {
            instance,
            userName: created.userName,
            host: created.host,
            password: "Alchemy-test-pass-2",
          });
        }),
      );

      expect(updated.userName).toEqual(created.userName);
      expect(updated.instance).toEqual(created.instance);

      const refetched = yield* sqladmin.getUsers({
        project: updated.project,
        instance: updated.instance,
        name: updated.userName,
        ...(updated.host ? { host: updated.host } : {}),
      });
      expect(refetched.name).toEqual(updated.userName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.instance,
        created.userName,
        created.host,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
