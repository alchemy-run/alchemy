import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Instance = Stackit.RabbitMQ.Instance("RabbitMQBindingsInstance", {
  version: "4.1",
  planName: "stackit-rabbitmq-2.4.10-single",
  // The broker routes come from a Worker's egress IPs, and the suite calls it too.
  acl: ["0.0.0.0/0"],
});

export const AppCredential = Instance.pipe(
  Effect.flatMap((instance) =>
    Stackit.RabbitMQ.Credential("RabbitMQBindingsCredential", { instanceId: instance.instanceId }),
  ),
);

/**
 * A Cloudflare Worker with every RabbitMQ binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class RabbitMQBindingsWorker extends Cloudflare.Worker<RabbitMQBindingsWorker>()(
  "StackitRabbitMQBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Instance;
    const credential = yield* AppCredential;
    const getInstance = yield* Stackit.RabbitMQ.GetInstance(instance);
    const listCredentials = yield* Stackit.RabbitMQ.ListCredentials(instance);
    const getCredential = yield* Stackit.RabbitMQ.GetCredential(instance);
    const getMetrics = yield* Stackit.RabbitMQ.GetMetrics(instance);
    const listBackups = yield* Stackit.RabbitMQ.ListBackups(instance);
    const createBackup = yield* Stackit.RabbitMQ.CreateBackup(instance);
    const downloadBackup = yield* Stackit.RabbitMQ.DownloadBackup(instance);
    const triggerRestore = yield* Stackit.RabbitMQ.TriggerRestore(instance);
    const listRestores = yield* Stackit.RabbitMQ.ListRestores(instance);
    const triggerRestart = yield* Stackit.RabbitMQ.TriggerRestart(instance);
    const triggerRecreate = yield* Stackit.RabbitMQ.TriggerRecreate(instance);
    const getUpdates = yield* Stackit.RabbitMQ.GetUpdates(instance);
    const triggerUpdate = yield* Stackit.RabbitMQ.TriggerUpdate(instance);
    const connect = yield* Stackit.RabbitMQ.Connect(credential);
    const getOverview = yield* Stackit.RabbitMQ.GetOverview(credential);
    const listQueues = yield* Stackit.RabbitMQ.ListQueues(credential);
    const getQueue = yield* Stackit.RabbitMQ.GetQueue(credential);
    const declareQueue = yield* Stackit.RabbitMQ.DeclareQueue(credential);
    const deleteQueue = yield* Stackit.RabbitMQ.DeleteQueue(credential);
    const purgeQueue = yield* Stackit.RabbitMQ.PurgeQueue(credential);
    const getMessages = yield* Stackit.RabbitMQ.GetMessages(credential);
    const listExchanges = yield* Stackit.RabbitMQ.ListExchanges(credential);
    const getExchange = yield* Stackit.RabbitMQ.GetExchange(credential);
    const declareExchange = yield* Stackit.RabbitMQ.DeclareExchange(credential);
    const deleteExchange = yield* Stackit.RabbitMQ.DeleteExchange(credential);
    const listQueueBindings = yield* Stackit.RabbitMQ.ListQueueBindings(credential);
    const bindQueue = yield* Stackit.RabbitMQ.BindQueue(credential);
    const unbindQueue = yield* Stackit.RabbitMQ.UnbindQueue(credential);
    const publish = yield* Stackit.RabbitMQ.Publish(credential);

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
                  hasUri: Redacted.value(info.uri).length > 0,
                  hasHttpApiUri:
                    info.httpApiUri !== undefined && Redacted.value(info.httpApiUri).length > 0,
                })),
              ),
            );
          case "/get-overview":
            return yield* respond(getOverview({}));
          case "/list-queues":
            return yield* respond(listQueues({}));
          case "/get-queue":
            return yield* respond(getQueue({ queue: id }));
          case "/declare-queue":
            return yield* respond(declareQueue({ queue: id, durable: true }));
          case "/delete-queue":
            return yield* respond(deleteQueue({ queue: id }));
          case "/purge-queue":
            return yield* respond(purgeQueue({ queue: id }));
          case "/get-messages":
            return yield* respond(
              getMessages({ queue: id, count: 10, ackmode: "ack_requeue_true", encoding: "auto" }),
            );
          case "/list-exchanges":
            return yield* respond(listExchanges({}));
          case "/get-exchange":
            return yield* respond(getExchange({ exchange: id }));
          case "/declare-exchange":
            return yield* respond(declareExchange({ exchange: id, type: "topic", durable: true }));
          case "/delete-exchange":
            return yield* respond(deleteExchange({ exchange: id }));
          case "/list-queue-bindings":
            return yield* respond(listQueueBindings({ queue: id }));
          case "/bind-queue":
            return yield* respond(
              bindQueue({
                exchange: url.searchParams.get("exchange") ?? "",
                queue: id,
                routing_key: url.searchParams.get("key") ?? "",
              }),
            );
          case "/unbind-queue":
            return yield* respond(
              unbindQueue({
                exchange: url.searchParams.get("exchange") ?? "",
                queue: id,
                propertiesKey: url.searchParams.get("key") ?? "",
              }),
            );
          case "/publish":
            return yield* respond(
              publish({
                exchange: url.searchParams.get("exchange") ?? undefined,
                routing_key: id,
                payload: url.searchParams.get("payload") ?? "",
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
        Stackit.RabbitMQ.GetInstanceHttp,
        Stackit.RabbitMQ.ListCredentialsHttp,
        Stackit.RabbitMQ.GetCredentialHttp,
        Stackit.RabbitMQ.GetMetricsHttp,
        Stackit.RabbitMQ.ListBackupsHttp,
        Stackit.RabbitMQ.CreateBackupHttp,
        Stackit.RabbitMQ.DownloadBackupHttp,
        Stackit.RabbitMQ.TriggerRestoreHttp,
        Stackit.RabbitMQ.ListRestoresHttp,
        Stackit.RabbitMQ.TriggerRestartHttp,
        Stackit.RabbitMQ.TriggerRecreateHttp,
        Stackit.RabbitMQ.GetUpdatesHttp,
        Stackit.RabbitMQ.TriggerUpdateHttp,
        Stackit.RabbitMQ.ConnectHttp,
        Stackit.RabbitMQ.GetOverviewHttp,
        Stackit.RabbitMQ.ListQueuesHttp,
        Stackit.RabbitMQ.GetQueueHttp,
        Stackit.RabbitMQ.DeclareQueueHttp,
        Stackit.RabbitMQ.DeleteQueueHttp,
        Stackit.RabbitMQ.PurgeQueueHttp,
        Stackit.RabbitMQ.GetMessagesHttp,
        Stackit.RabbitMQ.ListExchangesHttp,
        Stackit.RabbitMQ.GetExchangeHttp,
        Stackit.RabbitMQ.DeclareExchangeHttp,
        Stackit.RabbitMQ.DeleteExchangeHttp,
        Stackit.RabbitMQ.ListQueueBindingsHttp,
        Stackit.RabbitMQ.BindQueueHttp,
        Stackit.RabbitMQ.UnbindQueueHttp,
        Stackit.RabbitMQ.PublishHttp,
      ),
    ),
  ),
) {}
