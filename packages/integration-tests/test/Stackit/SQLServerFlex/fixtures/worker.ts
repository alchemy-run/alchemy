import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const ROLES = ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"];

export const Db = Stackit.SQLServerFlex.Instance("SqlServerFlexBindingsInstance", {
  flavorId: "4.16-Single",
  version: "2022",
  storage: { class: "premium-perf2-stackit", size: 5 },
  backupSchedule: "0 2 * * *",
  retentionDays: 32,
  // Nothing connects: `Connect` opens no socket, and the rest go through the API.
  acl: ["192.0.2.1/32"],
});

export const AppUser = Db.pipe(
  Effect.flatMap((db) =>
    Stackit.SQLServerFlex.User("SqlServerFlexBindingsUser", {
      instanceId: db.instanceId,
      roles: ROLES,
    }),
  ),
);

export const AppDatabase = Effect.gen(function* () {
  const db = yield* Db;
  const user = yield* AppUser;
  return yield* Stackit.SQLServerFlex.Database("SqlServerFlexBindingsDatabase", {
    instanceId: db.instanceId,
    owner: user.userName,
  });
});

/**
 * A Cloudflare Worker with every SQL Server Flex binding. One route per binding; each
 * answers `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class SqlServerFlexBindingsWorker extends Cloudflare.Worker<SqlServerFlexBindingsWorker>()(
  "StackitSqlServerFlexBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const db = yield* Db;
    const user = yield* AppUser;
    const database = yield* AppDatabase;
    const getInstance = yield* Stackit.SQLServerFlex.GetInstance(db);
    const listDatabases = yield* Stackit.SQLServerFlex.ListDatabases(db);
    const getDatabase = yield* Stackit.SQLServerFlex.GetDatabase(db);
    const listUsers = yield* Stackit.SQLServerFlex.ListUsers(db);
    const getUser = yield* Stackit.SQLServerFlex.GetUser(db);
    const resetUser = yield* Stackit.SQLServerFlex.ResetUser(db);
    const listBackups = yield* Stackit.SQLServerFlex.ListBackups(db);
    const getBackup = yield* Stackit.SQLServerFlex.GetBackup(db);
    const triggerBackup = yield* Stackit.SQLServerFlex.TriggerBackup(db);
    const triggerRestore = yield* Stackit.SQLServerFlex.TriggerRestore(db);
    const restoreDatabaseFromBackup = yield* Stackit.SQLServerFlex.RestoreDatabaseFromBackup(db);
    const listRestoreJobs = yield* Stackit.SQLServerFlex.ListRestoreJobs(db);
    const readInstance = yield* Stackit.SQLServerFlex.ReadInstance(db);
    const writeInstance = yield* Stackit.SQLServerFlex.WriteInstance(db);
    const readWriteInstance = yield* Stackit.SQLServerFlex.ReadWriteInstance(db);
    const connect = yield* Stackit.SQLServerFlex.Connect(database, user);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    /** The name a reset answered for; the new password never leaves the Worker. */
    const rotated = (response: { readonly username: string }) => ({ name: response.username });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = Number(url.searchParams.get("id"));
        const name = url.searchParams.get("name") ?? "";
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-databases":
            return yield* respond(listDatabases({}));
          case "/get-database":
            return yield* respond(getDatabase({ databaseName: name }));
          case "/list-users":
            return yield* respond(listUsers({}));
          case "/get-user":
            return yield* respond(getUser({ userId: id }));
          case "/reset-user":
            return yield* respond(resetUser({ userId: id }).pipe(Effect.map(rotated)));
          case "/list-backups":
            return yield* respond(listBackups({}));
          case "/get-backup":
            return yield* respond(getBackup({ backupId: id }));
          case "/trigger-backup":
            return yield* respond(
              triggerBackup({ databaseName: name }).pipe(Effect.as({ started: name })),
            );
          case "/trigger-restore":
            return yield* respond(
              triggerRestore({
                databaseName: name,
                name: url.searchParams.get("target") ?? "",
                restoreDateTime: url.searchParams.get("time") ?? "",
              }).pipe(Effect.as({ started: name })),
            );
          case "/restore-database-from-backup":
            return yield* respond(
              restoreDatabaseFromBackup({
                database_name: name,
                source: { type: "BACKUP" },
              }).pipe(Effect.as({ started: name })),
            );
          case "/list-restore-jobs":
            return yield* respond(listRestoreJobs({}));
          case "/read-instance":
            return yield* respond(
              Effect.all({
                instance: readInstance.getInstance(),
                databases: readInstance.listDatabases(),
                users: readInstance.listUsers(),
                backups: readInstance.listBackups(),
                restoreJobs: readInstance.listRestoreJobs(),
              }),
            );
          case "/write-instance":
            return yield* respond(
              writeInstance.resetUser({ userId: id }).pipe(Effect.map(rotated)),
            );
          case "/read-write-instance":
            return yield* respond(
              Effect.gen(function* () {
                const live = yield* readWriteInstance.getUser({ userId: id });
                const reset = yield* readWriteInstance.resetUser({ userId: id });
                return { read: live.username, ...rotated(reset) };
              }),
            );
          case "/connect":
            return yield* respond(
              connect.pipe(
                Effect.map((info) => ({
                  host: info.host,
                  port: info.port,
                  database: info.database,
                  username: info.username,
                  encrypt: info.encrypt,
                  hasPassword: Redacted.value(info.password).length > 0,
                  connectionStringServer: Redacted.value(info.connectionString).split(";")[0],
                })),
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
        Stackit.SQLServerFlex.GetInstanceHttp,
        Stackit.SQLServerFlex.ListDatabasesHttp,
        Stackit.SQLServerFlex.GetDatabaseHttp,
        Stackit.SQLServerFlex.ListUsersHttp,
        Stackit.SQLServerFlex.GetUserHttp,
        Stackit.SQLServerFlex.ResetUserHttp,
        Stackit.SQLServerFlex.ListBackupsHttp,
        Stackit.SQLServerFlex.GetBackupHttp,
        Stackit.SQLServerFlex.TriggerBackupHttp,
        Stackit.SQLServerFlex.TriggerRestoreHttp,
        Stackit.SQLServerFlex.RestoreDatabaseFromBackupHttp,
        Stackit.SQLServerFlex.ListRestoreJobsHttp,
        Stackit.SQLServerFlex.ReadInstanceHttp,
        Stackit.SQLServerFlex.WriteInstanceHttp,
        Stackit.SQLServerFlex.ReadWriteInstanceHttp,
        Stackit.SQLServerFlex.ConnectHttp,
      ),
    ),
  ),
) {}
