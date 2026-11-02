import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Db = Stackit.PostgresFlex.Instance("PostgresFlexBindingsInstance", {
  flavorId: "2.4",
  version: "17",
  storage: { class: "premium-perf2-stackit", size: 5 },
  backupSchedule: "0 2 * * *",
  retentionDays: 32,
  // Nothing connects: `Connect` opens no socket, and the rest go through the API.
  acl: ["192.0.2.1/32"],
});

export const AppUser = Db.pipe(
  Effect.flatMap((db) =>
    Stackit.PostgresFlex.User("PostgresFlexBindingsUser", { instanceId: db.instanceId }),
  ),
);

export const AppDatabase = Effect.gen(function* () {
  const db = yield* Db;
  const user = yield* AppUser;
  return yield* Stackit.PostgresFlex.Database("PostgresFlexBindingsDatabase", {
    instanceId: db.instanceId,
    owner: user.userName,
  });
});

/**
 * A Cloudflare Worker with every PostgreSQL Flex binding. One route per binding; each
 * answers `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class PostgresFlexBindingsWorker extends Cloudflare.Worker<PostgresFlexBindingsWorker>()(
  "StackitPostgresFlexBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const db = yield* Db;
    const user = yield* AppUser;
    const database = yield* AppDatabase;
    const getInstance = yield* Stackit.PostgresFlex.GetInstance(db);
    const listDatabases = yield* Stackit.PostgresFlex.ListDatabases(db);
    const getDatabase = yield* Stackit.PostgresFlex.GetDatabase(db);
    const listUsers = yield* Stackit.PostgresFlex.ListUsers(db);
    const getUser = yield* Stackit.PostgresFlex.GetUser(db);
    const listBackups = yield* Stackit.PostgresFlex.ListBackups(db);
    const getBackup = yield* Stackit.PostgresFlex.GetBackup(db);
    const resetUserPassword = yield* Stackit.PostgresFlex.ResetUserPassword(db);
    const readInstance = yield* Stackit.PostgresFlex.ReadInstance(db);
    const writeInstance = yield* Stackit.PostgresFlex.WriteInstance(db);
    const readWriteInstance = yield* Stackit.PostgresFlex.ReadWriteInstance(db);
    const connect = yield* Stackit.PostgresFlex.Connect(database, user);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    /** The name a reset answered for; the new password never leaves the Worker. */
    const rotated = (response: { readonly name: string }) => ({ name: response.name });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = Number(url.searchParams.get("id"));
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-databases":
            return yield* respond(listDatabases({}));
          case "/get-database":
            return yield* respond(getDatabase({ databaseId: id }));
          case "/list-users":
            return yield* respond(listUsers({}));
          case "/get-user":
            return yield* respond(getUser({ userId: id }));
          case "/list-backups":
            return yield* respond(listBackups({}));
          case "/get-backup":
            return yield* respond(
              getBackup({ backupId: id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed({ missing: true })),
              ),
            );
          case "/reset-user-password":
            return yield* respond(resetUserPassword({ userId: id }).pipe(Effect.map(rotated)));
          case "/read-instance":
            return yield* respond(
              Effect.all({
                instance: readInstance.getInstance(),
                databases: readInstance.listDatabases(),
                users: readInstance.listUsers(),
                backups: readInstance.listBackups(),
              }),
            );
          case "/write-instance":
            return yield* respond(
              writeInstance.resetUserPassword({ userId: id }).pipe(Effect.map(rotated)),
            );
          case "/read-write-instance":
            return yield* respond(
              Effect.gen(function* () {
                const live = yield* readWriteInstance.getUser({ userId: id });
                const reset = yield* readWriteInstance.resetUserPassword({ userId: id });
                return { read: live.name, ...rotated(reset) };
              }),
            );
          case "/connect":
            return yield* respond(
              connect.pipe(
                Effect.map((info) => {
                  const parsed = new URL(Redacted.value(info.url));
                  return {
                    host: info.host,
                    port: info.port,
                    database: info.database,
                    username: info.username,
                    ssl: info.ssl,
                    hasPassword: Redacted.value(info.password).length > 0,
                    urlHost: parsed.hostname,
                    urlDatabase: parsed.pathname,
                    urlSslMode: parsed.searchParams.get("sslmode"),
                  };
                }),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.PostgresFlex.GetInstanceHttp,
        Stackit.PostgresFlex.ListDatabasesHttp,
        Stackit.PostgresFlex.GetDatabaseHttp,
        Stackit.PostgresFlex.ListUsersHttp,
        Stackit.PostgresFlex.GetUserHttp,
        Stackit.PostgresFlex.ListBackupsHttp,
        Stackit.PostgresFlex.GetBackupHttp,
        Stackit.PostgresFlex.ResetUserPasswordHttp,
        Stackit.PostgresFlex.ReadInstanceHttp,
        Stackit.PostgresFlex.WriteInstanceHttp,
        Stackit.PostgresFlex.ReadWriteInstanceHttp,
        Stackit.PostgresFlex.ConnectHttp,
      ),
    ),
  ),
) {}
