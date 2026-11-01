import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Search = Stackit.OpenSearch.Instance("OpenSearchBindingsInstance", {
  version: "2",
  planName: "stackit-opensearch-1.4.10-single",
  // A Worker's egress addresses aren't a fixed range, and the data bindings have to
  // reach the instance. Nothing but this suite's documents live on it.
  acl: ["0.0.0.0/0"],
});

export const App = Search.pipe(
  Effect.flatMap((search) =>
    Stackit.OpenSearch.Credential("OpenSearchBindingsCredential", {
      instanceId: search.instanceId,
    }),
  ),
);

/**
 * A Cloudflare Worker with every OpenSearch binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test.
 */
export default class OpenSearchBindingsWorker extends Cloudflare.Worker<OpenSearchBindingsWorker>()(
  "StackitOpenSearchBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Search;
    const credential = yield* App;
    const credentialId = yield* credential.credentialId;
    const getInstance = yield* Stackit.OpenSearch.GetInstance(instance);
    const listCredentials = yield* Stackit.OpenSearch.ListCredentials(instance);
    const getCredential = yield* Stackit.OpenSearch.GetCredential(instance);
    const getMetrics = yield* Stackit.OpenSearch.GetMetrics(instance);
    const listBackups = yield* Stackit.OpenSearch.ListBackups(instance);
    const createBackup = yield* Stackit.OpenSearch.CreateBackup(instance);
    const downloadBackup = yield* Stackit.OpenSearch.DownloadBackup(instance);
    const triggerRestore = yield* Stackit.OpenSearch.TriggerRestore(instance);
    const listRestores = yield* Stackit.OpenSearch.ListRestores(instance);
    const triggerRestart = yield* Stackit.OpenSearch.TriggerRestart(instance);
    const triggerRecreate = yield* Stackit.OpenSearch.TriggerRecreate(instance);
    const getUpdates = yield* Stackit.OpenSearch.GetUpdates(instance);
    const triggerUpdate = yield* Stackit.OpenSearch.TriggerUpdate(instance);
    const connect = yield* Stackit.OpenSearch.Connect(credential);
    const search = yield* Stackit.OpenSearch.Search(credential);
    const indexDocument = yield* Stackit.OpenSearch.IndexDocument(credential);
    const getDocument = yield* Stackit.OpenSearch.GetDocument(credential);
    const deleteDocument = yield* Stackit.OpenSearch.DeleteDocument(credential);
    const bulk = yield* Stackit.OpenSearch.Bulk(credential);
    const readIndex = yield* Stackit.OpenSearch.ReadIndex(credential);
    const writeIndex = yield* Stackit.OpenSearch.WriteIndex(credential);
    const readWriteIndex = yield* Stackit.OpenSearch.ReadWriteIndex(credential);

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
        const index = url.searchParams.get("index") ?? "bindings";
        const doc = url.searchParams.get("doc") ?? "1";
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
            // The address and user; the password never leaves the Worker.
            return yield* respond(
              connect.pipe(
                Effect.map((info) => ({
                  host: info.host,
                  port: info.port,
                  username: info.username,
                })),
              ),
            );
          case "/search":
            return yield* respond(search({ index, query: { match: { sku: "tea" } } }));
          case "/index-document":
            return yield* respond(
              indexDocument({ index, id: doc, refresh: "true", body: { sku: "tea" } }),
            );
          case "/add-document":
            return yield* respond(indexDocument({ index, refresh: "true", body: { sku: "tea" } }));
          case "/get-document":
            return yield* respond(getDocument({ index, id: doc }));
          case "/delete-document":
            return yield* respond(deleteDocument({ index, id: doc, refresh: "true" }));
          case "/bulk":
            return yield* respond(
              bulk({
                index,
                refresh: "true",
                lines: [{ index: { _id: doc } }, { sku: "bulk" }],
              }),
            );
          case "/read-index":
            return yield* respond(readIndex.search({ index, query: { match: { sku: "read" } } }));
          case "/write-index":
            return yield* respond(
              writeIndex.index({ index, id: doc, refresh: "true", body: { sku: "read" } }),
            );
          case "/read-write-index":
            return yield* respond(
              readWriteIndex
                .index({ index, id: doc, refresh: "true", body: { sku: "both" } })
                .pipe(Effect.flatMap(() => readWriteIndex.get({ index, id: doc }))),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.OpenSearch.GetInstanceHttp,
        Stackit.OpenSearch.ListCredentialsHttp,
        Stackit.OpenSearch.GetCredentialHttp,
        Stackit.OpenSearch.GetMetricsHttp,
        Stackit.OpenSearch.ListBackupsHttp,
        Stackit.OpenSearch.CreateBackupHttp,
        Stackit.OpenSearch.DownloadBackupHttp,
        Stackit.OpenSearch.TriggerRestoreHttp,
        Stackit.OpenSearch.ListRestoresHttp,
        Stackit.OpenSearch.TriggerRestartHttp,
        Stackit.OpenSearch.TriggerRecreateHttp,
        Stackit.OpenSearch.GetUpdatesHttp,
        Stackit.OpenSearch.TriggerUpdateHttp,
        Stackit.OpenSearch.ConnectHttp,
        Stackit.OpenSearch.SearchHttp,
        Stackit.OpenSearch.IndexDocumentHttp,
        Stackit.OpenSearch.GetDocumentHttp,
        Stackit.OpenSearch.DeleteDocumentHttp,
        Stackit.OpenSearch.BulkHttp,
        Stackit.OpenSearch.ReadIndexHttp,
        Stackit.OpenSearch.WriteIndexHttp,
        Stackit.OpenSearch.ReadWriteIndexHttp,
      ),
    ),
  ),
) {}
