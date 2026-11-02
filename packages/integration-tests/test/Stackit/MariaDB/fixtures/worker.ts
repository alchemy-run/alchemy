import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Instance = Stackit.MariaDB.Instance("MariaDBBindingsInstance", {
  version: "10.11",
  planName: "stackit-mariadb-1.2.10-single",
  // Nothing connects: `Connect` opens no socket, and the rest go through the API.
  acl: ["192.0.2.1/32"],
});

export const AppCredential = Instance.pipe(
  Effect.flatMap((instance) =>
    Stackit.MariaDB.Credential("MariaDBBindingsCredential", { instanceId: instance.instanceId }),
  ),
);

/**
 * A Cloudflare Worker with every MariaDB binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class MariaDBBindingsWorker extends Cloudflare.Worker<MariaDBBindingsWorker>()(
  "StackitMariaDBBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Instance;
    const credential = yield* AppCredential;
    const getInstance = yield* Stackit.MariaDB.GetInstance(instance);
    const listCredentials = yield* Stackit.MariaDB.ListCredentials(instance);
    const getCredential = yield* Stackit.MariaDB.GetCredential(instance);
    const getMetrics = yield* Stackit.MariaDB.GetMetrics(instance);
    const listBackups = yield* Stackit.MariaDB.ListBackups(instance);
    const createBackup = yield* Stackit.MariaDB.CreateBackup(instance);
    const downloadBackup = yield* Stackit.MariaDB.DownloadBackup(instance);
    const triggerRestore = yield* Stackit.MariaDB.TriggerRestore(instance);
    const listRestores = yield* Stackit.MariaDB.ListRestores(instance);
    const triggerRestart = yield* Stackit.MariaDB.TriggerRestart(instance);
    const triggerRecreate = yield* Stackit.MariaDB.TriggerRecreate(instance);
    const getUpdates = yield* Stackit.MariaDB.GetUpdates(instance);
    const triggerUpdate = yield* Stackit.MariaDB.TriggerUpdate(instance);
    const connect = yield* Stackit.MariaDB.Connect(credential);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = url.searchParams.get("id") ?? "";
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(
              getInstance({}).pipe(
                Effect.map((live) => ({
                  name: live.name,
                  status: live.status,
                  planName: live.planName,
                })),
              ),
            );
          case "/list-credentials":
            return yield* respond(listCredentials({}));
          case "/get-credential":
            // The password never leaves the Worker.
            return yield* respond(
              getCredential({ credentialsId: id }).pipe(
                Effect.map((found) => ({
                  id: found.id,
                  username: found.raw?.credentials.username,
                  hasPassword:
                    found.raw !== undefined && Redacted.isRedacted(found.raw.credentials.password),
                })),
              ),
            );
          case "/get-metrics":
            return yield* respond(getMetrics({}));
          case "/list-backups":
            return yield* respond(listBackups({}));
          case "/create-backup":
            return yield* respond(createBackup({}));
          case "/download-backup":
            return yield* respond(
              downloadBackup({ backupId: Number(id) }).pipe(
                Effect.map((archive) => ({ size: archive.length })),
              ),
            );
          case "/trigger-restore":
            return yield* respond(triggerRestore({ backupId: Number(id) }));
          case "/list-restores":
            return yield* respond(listRestores({}));
          case "/trigger-restart":
            return yield* respond(triggerRestart({}));
          case "/trigger-recreate":
            return yield* respond(triggerRecreate({}));
          case "/get-updates":
            return yield* respond(getUpdates({}));
          case "/trigger-update":
            return yield* respond(
              triggerUpdate({}).pipe(
                // The spec documents a 409, without saying when it answers one.
                Effect.catchTag("Conflict", () => Effect.succeed({ conflict: true })),
              ),
            );
          case "/connect":
            return yield* respond(
              connect.pipe(
                Effect.map((info) => ({
                  host: info.host,
                  port: info.port,
                  username: info.username,
                  hasPassword: Redacted.value(info.password).length > 0,
                  hasUrl: Redacted.value(info.url).length > 0,
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
        Stackit.MariaDB.GetInstanceHttp,
        Stackit.MariaDB.ListCredentialsHttp,
        Stackit.MariaDB.GetCredentialHttp,
        Stackit.MariaDB.GetMetricsHttp,
        Stackit.MariaDB.ListBackupsHttp,
        Stackit.MariaDB.CreateBackupHttp,
        Stackit.MariaDB.DownloadBackupHttp,
        Stackit.MariaDB.TriggerRestoreHttp,
        Stackit.MariaDB.ListRestoresHttp,
        Stackit.MariaDB.TriggerRestartHttp,
        Stackit.MariaDB.TriggerRecreateHttp,
        Stackit.MariaDB.GetUpdatesHttp,
        Stackit.MariaDB.TriggerUpdateHttp,
        Stackit.MariaDB.ConnectHttp,
      ),
    ),
  ),
) {}
