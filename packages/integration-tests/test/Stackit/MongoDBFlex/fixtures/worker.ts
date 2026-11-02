import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Db = Stackit.MongoDBFlex.Instance("MongoDBFlexBindingsInstance", {
  flavorId: "1.2",
  version: "7.0",
  replicas: 3,
  type: "Replica",
  storage: { class: "premium-perf2-mongodb", size: 10 },
  // Nothing connects: `Connect` opens no socket, and the rest go through the API.
  acl: ["192.0.2.1/32"],
  backupSchedule: "0 2 * * *",
});

export const AppUser = Db.pipe(
  Effect.flatMap((db) =>
    Stackit.MongoDBFlex.User("MongoDBFlexBindingsUser", {
      instanceId: db.instanceId,
      database: "app",
      roles: ["read"],
    }),
  ),
);

/**
 * A Cloudflare Worker with every MongoDB Flex binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class MongoDBFlexBindingsWorker extends Cloudflare.Worker<MongoDBFlexBindingsWorker>()(
  "StackitMongoDBFlexBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const db = yield* Db;
    const user = yield* AppUser;
    const getInstance = yield* Stackit.MongoDBFlex.GetInstance(db);
    const listUsers = yield* Stackit.MongoDBFlex.ListUsers(db);
    const getUser = yield* Stackit.MongoDBFlex.GetUser(db);
    const resetUser = yield* Stackit.MongoDBFlex.ResetUser(db);
    const listBackups = yield* Stackit.MongoDBFlex.ListBackups(db);
    const getBackup = yield* Stackit.MongoDBFlex.GetBackup(db);
    const cloneInstance = yield* Stackit.MongoDBFlex.CloneInstance(db);
    const restoreInstance = yield* Stackit.MongoDBFlex.RestoreInstance(db);
    const listRestoreJobs = yield* Stackit.MongoDBFlex.ListRestoreJobs(db);
    const listMetrics = yield* Stackit.MongoDBFlex.ListMetrics(db);
    const listAdvisorSlowQueries = yield* Stackit.MongoDBFlex.ListAdvisorSlowQueries(db);
    const listSuggestedIndexes = yield* Stackit.MongoDBFlex.ListSuggestedIndexes(db);
    const readInstance = yield* Stackit.MongoDBFlex.ReadInstance(db);
    const writeInstance = yield* Stackit.MongoDBFlex.WriteInstance(db);
    const readWriteInstance = yield* Stackit.MongoDBFlex.ReadWriteInstance(db);
    const connect = yield* Stackit.MongoDBFlex.Connect(user);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    /** The name a reset answered for; the new password never leaves the Worker. */
    const rotated = (response: { readonly username?: string | undefined }) => ({
      username: response.username,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = url.searchParams.get("id") ?? "";
        const target = url.searchParams.get("target") ?? "";
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-users":
            return yield* respond(listUsers({}));
          case "/get-user":
            return yield* respond(getUser({ userId: id }));
          case "/reset-user":
            return yield* respond(resetUser({ userId: id }).pipe(Effect.map(rotated)));
          case "/list-backups":
            return yield* respond(listBackups({}));
          case "/get-backup":
            return yield* respond(
              getBackup({ backupId: id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed({ missing: true })),
              ),
            );
          // The instance is too new for a backup, so these two prove the host's grant:
          // the API takes the host's identity and answers about the request.
          case "/clone-instance":
            return yield* respond(
              cloneInstance({
                targetInstanceId: target,
                timestamp: "2000-01-01T00:00:00Z",
              }).pipe(
                Effect.catchTag(["BadRequest", "NotFound"], (error) =>
                  Effect.succeed({ rejected: error._tag }),
                ),
              ),
            );
          case "/restore-instance":
            return yield* respond(
              restoreInstance({ backupId: id, targetInstanceId: target }).pipe(
                Effect.catchTag(["BadRequest", "NotFound"], (error) =>
                  Effect.succeed({ rejected: error._tag }),
                ),
              ),
            );
          case "/list-restore-jobs":
            return yield* respond(listRestoreJobs({}));
          case "/list-metrics":
            return yield* respond(
              listMetrics({ metric: "cpu", granularity: "PT5M", period: "PT1H" }),
            );
          case "/list-advisor-slow-queries":
            return yield* respond(listAdvisorSlowQueries({}));
          case "/list-suggested-indexes":
            return yield* respond(listSuggestedIndexes({}));
          case "/read-instance":
            return yield* respond(
              Effect.all({
                instance: readInstance.getInstance(),
                users: readInstance.listUsers(),
                backups: readInstance.listBackups(),
                restores: readInstance.listRestoreJobs(),
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
                return { read: live.item?.username, ...rotated(reset) };
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
                  hasPassword: Redacted.value(info.password).length > 0,
                  uriHasUser: Redacted.value(info.uri).includes(info.username),
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
        Stackit.MongoDBFlex.GetInstanceHttp,
        Stackit.MongoDBFlex.ListUsersHttp,
        Stackit.MongoDBFlex.GetUserHttp,
        Stackit.MongoDBFlex.ResetUserHttp,
        Stackit.MongoDBFlex.ListBackupsHttp,
        Stackit.MongoDBFlex.GetBackupHttp,
        Stackit.MongoDBFlex.CloneInstanceHttp,
        Stackit.MongoDBFlex.RestoreInstanceHttp,
        Stackit.MongoDBFlex.ListRestoreJobsHttp,
        Stackit.MongoDBFlex.ListMetricsHttp,
        Stackit.MongoDBFlex.ListAdvisorSlowQueriesHttp,
        Stackit.MongoDBFlex.ListSuggestedIndexesHttp,
        Stackit.MongoDBFlex.ReadInstanceHttp,
        Stackit.MongoDBFlex.WriteInstanceHttp,
        Stackit.MongoDBFlex.ReadWriteInstanceHttp,
        Stackit.MongoDBFlex.ConnectHttp,
      ),
    ),
  ),
) {}
