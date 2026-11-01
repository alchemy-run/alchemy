import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Logs = Stackit.LogMe.Instance("LogMeBindingsInstance", {
  version: "2",
  planName: "stackit-logme2-1.2.50-replica",
  // A Worker's egress addresses aren't a fixed range, and the data bindings have to
  // reach the instance. Nothing but this suite's lines live on it.
  acl: ["0.0.0.0/0"],
});

export const App = Logs.pipe(
  Effect.flatMap((logs) =>
    Stackit.LogMe.Credential("LogMeBindingsCredential", { instanceId: logs.instanceId }),
  ),
);

/**
 * A Cloudflare Worker with every LogMe binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test.
 */
export default class LogMeBindingsWorker extends Cloudflare.Worker<LogMeBindingsWorker>()(
  "StackitLogMeBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Logs;
    const credential = yield* App;
    const credentialId = yield* credential.credentialId;
    const getInstance = yield* Stackit.LogMe.GetInstance(instance);
    const listCredentials = yield* Stackit.LogMe.ListCredentials(instance);
    const getCredential = yield* Stackit.LogMe.GetCredential(instance);
    const getMetrics = yield* Stackit.LogMe.GetMetrics(instance);
    const listBackups = yield* Stackit.LogMe.ListBackups(instance);
    const createBackup = yield* Stackit.LogMe.CreateBackup(instance);
    const downloadBackup = yield* Stackit.LogMe.DownloadBackup(instance);
    const triggerRestore = yield* Stackit.LogMe.TriggerRestore(instance);
    const listRestores = yield* Stackit.LogMe.ListRestores(instance);
    const triggerRestart = yield* Stackit.LogMe.TriggerRestart(instance);
    const triggerRecreate = yield* Stackit.LogMe.TriggerRecreate(instance);
    const getUpdates = yield* Stackit.LogMe.GetUpdates(instance);
    const triggerUpdate = yield* Stackit.LogMe.TriggerUpdate(instance);
    const connect = yield* Stackit.LogMe.Connect(credential);
    const searchLogs = yield* Stackit.LogMe.SearchLogs(credential);
    const writeLog = yield* Stackit.LogMe.WriteLog(credential);

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
        const id = Number(url.searchParams.get("id"));
        const liveCredentialId = yield* credentialId;
        const marker = url.searchParams.get("marker") ?? "alchemy-logme-marker";
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-credentials":
            return yield* respond(listCredentials({}));
          case "/get-credential":
            // The id and user; the password never leaves the Worker.
            return yield* respond(
              getCredential({ credentialsId: liveCredentialId }).pipe(
                Effect.map((found) => ({
                  id: found.id,
                  username: found.raw?.credentials.username,
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
              downloadBackup({ backupId: id }).pipe(
                Effect.map((archive) => ({ size: archive.length })),
              ),
            );
          case "/trigger-restore":
            return yield* respond(triggerRestore({ backupId: id }));
          case "/list-restores":
            return yield* respond(listRestores({}));
          case "/trigger-restart":
            return yield* respond(triggerRestart({}));
          case "/trigger-recreate":
            return yield* respond(triggerRecreate({}));
          case "/get-updates":
            return yield* respond(getUpdates({}));
          case "/trigger-update":
            return yield* respond(triggerUpdate({}));
          case "/connect":
            // The address and user; the password and URLs never leave the Worker.
            return yield* respond(
              connect.pipe(
                Effect.map((info) => ({
                  host: info.host,
                  port: info.port,
                  username: info.username,
                })),
              ),
            );
          case "/search-logs":
            return yield* respond(searchLogs({ query: { match_phrase: { message: marker } } }));
          case "/write-log":
            return yield* respond(
              writeLog({ message: marker, appName: "alchemy-test" }).pipe(Effect.as("sent")),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.LogMe.GetInstanceHttp,
        Stackit.LogMe.ListCredentialsHttp,
        Stackit.LogMe.GetCredentialHttp,
        Stackit.LogMe.GetMetricsHttp,
        Stackit.LogMe.ListBackupsHttp,
        Stackit.LogMe.CreateBackupHttp,
        Stackit.LogMe.DownloadBackupHttp,
        Stackit.LogMe.TriggerRestoreHttp,
        Stackit.LogMe.ListRestoresHttp,
        Stackit.LogMe.TriggerRestartHttp,
        Stackit.LogMe.TriggerRecreateHttp,
        Stackit.LogMe.GetUpdatesHttp,
        Stackit.LogMe.TriggerUpdateHttp,
        Stackit.LogMe.ConnectHttp,
        Stackit.LogMe.SearchLogsHttp,
        Stackit.LogMe.WriteLogHttp,
      ),
    ),
  ),
) {}
