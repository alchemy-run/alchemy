import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Instance = Stackit.Valkey.Instance("ValkeyBindingsInstance", {
  version: "x",
  planName: "stackit-keyvalue-1.2.10-single",
  // A Worker has no fixed egress range, and this throwaway instance holds only test
  // keys behind its generated password.
  acl: ["0.0.0.0/0"],
});

export const AppCredential = Instance.pipe(
  Effect.flatMap((instance) =>
    Stackit.Valkey.Credential("ValkeyBindingsCredential", { instanceId: instance.instanceId }),
  ),
);

const WRITTEN_KEY = "bindings:written";
const READ_WRITE_KEY = "bindings:read-write";

/**
 * A Cloudflare Worker with every Key Value Store binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class ValkeyBindingsWorker extends Cloudflare.Worker<ValkeyBindingsWorker>()(
  "StackitValkeyBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Instance;
    const credential = yield* AppCredential;
    const getInstance = yield* Stackit.Valkey.GetInstance(instance);
    const listCredentials = yield* Stackit.Valkey.ListCredentials(instance);
    const getCredential = yield* Stackit.Valkey.GetCredential(instance);
    const getMetrics = yield* Stackit.Valkey.GetMetrics(instance);
    const listBackups = yield* Stackit.Valkey.ListBackups(instance);
    const createBackup = yield* Stackit.Valkey.CreateBackup(instance);
    const downloadBackup = yield* Stackit.Valkey.DownloadBackup(instance);
    const triggerRestore = yield* Stackit.Valkey.TriggerRestore(instance);
    const listRestores = yield* Stackit.Valkey.ListRestores(instance);
    const triggerRestart = yield* Stackit.Valkey.TriggerRestart(instance);
    const triggerRecreate = yield* Stackit.Valkey.TriggerRecreate(instance);
    const getUpdates = yield* Stackit.Valkey.GetUpdates(instance);
    const triggerUpdate = yield* Stackit.Valkey.TriggerUpdate(instance);
    const connect = yield* Stackit.Valkey.Connect(credential);
    const readValkey = yield* Stackit.Valkey.ReadValkey(credential);
    const writeValkey = yield* Stackit.Valkey.WriteValkey(credential);
    const readWriteValkey = yield* Stackit.Valkey.ReadWriteValkey(credential);

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
          case "/write-valkey":
            return yield* respond(
              writeValkey.set(WRITTEN_KEY, id).pipe(Effect.as({ written: id })),
            );
          case "/read-valkey":
            return yield* respond(
              readValkey.get(WRITTEN_KEY).pipe(Effect.map((value) => ({ value }))),
            );
          case "/read-write-valkey":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWriteValkey.set(READ_WRITE_KEY, id);
                const value = yield* readWriteValkey.get(READ_WRITE_KEY);
                const pong = yield* readWriteValkey.ping();
                return { value, pong };
              }),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Valkey.GetInstanceHttp,
        Stackit.Valkey.ListCredentialsHttp,
        Stackit.Valkey.GetCredentialHttp,
        Stackit.Valkey.GetMetricsHttp,
        Stackit.Valkey.ListBackupsHttp,
        Stackit.Valkey.CreateBackupHttp,
        Stackit.Valkey.DownloadBackupHttp,
        Stackit.Valkey.TriggerRestoreHttp,
        Stackit.Valkey.ListRestoresHttp,
        Stackit.Valkey.TriggerRestartHttp,
        Stackit.Valkey.TriggerRecreateHttp,
        Stackit.Valkey.GetUpdatesHttp,
        Stackit.Valkey.TriggerUpdateHttp,
        Stackit.Valkey.ConnectHttp,
        Stackit.Valkey.ReadValkeyHttp,
        Stackit.Valkey.WriteValkeyHttp,
        Stackit.Valkey.ReadWriteValkeyHttp,
      ),
    ),
  ),
) {}
