import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
// TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the queue-binding fixture consumes. Module-scope so the test can
// yield the same declarations. Read-access geo-redundant storage, so
// `GetQueueServiceStatistics` has a secondary endpoint to call.
export const QueueData = Azure.Storage.StorageAccount("QueueBindingsData", {
  sku: "Standard_RAGRS",
});

const queue = (id: string, metadata?: Record<string, string>) =>
  Effect.gen(function* () {
    const account = yield* QueueData;
    return yield* Azure.Storage.Queue(id, {
      storageAccount: account.storageAccountName,
      metadata,
    });
  });

// One queue per binding, so concurrent tests never see each other's messages.
export const SendQueue = queue("QbSend");
export const ReceiveQueue = queue("QbReceive");
export const DeleteQueue = queue("QbDelete");
export const UpdateQueue = queue("QbUpdate");
export const PeekQueue = queue("QbPeek");
export const ClearQueue = queue("QbClear");
export const PropertiesQueue = queue("QbProperties", { purpose: "properties" });
export const AclGetQueue = queue("QbAclGet");
export const AclSetQueue = queue("QbAclSet");
export const ReadQueue = queue("QbRead", { purpose: "read" });
export const WriteQueue = queue("QbWrite");
export const ReadWriteQueue = queue("QbReadWrite");
export const ProcessorQueue = queue("QbProcessor");

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function with one route per `storage-queue` binding.
 * Routes answer `{ ok, result | error }` with a 500 on error, so a caller
 * retries through role propagation and a real failure shows the Azure
 * error.
 */
export default class QueueFunction extends Azure.Functions.Function<QueueFunction>()(
  "QueueBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* QueueData;
    const sendQueue = yield* SendQueue;
    const receiveQueue = yield* ReceiveQueue;
    const deleteQueue = yield* DeleteQueue;
    const updateQueue = yield* UpdateQueue;
    const peekQueue = yield* PeekQueue;
    const clearQueue = yield* ClearQueue;
    const propertiesQueue = yield* PropertiesQueue;
    const aclGetQueue = yield* AclGetQueue;
    const aclSetQueue = yield* AclSetQueue;
    const readQueue = yield* ReadQueue;
    const writeQueue = yield* WriteQueue;
    const readWriteQueue = yield* ReadWriteQueue;
    const processorQueue = yield* ProcessorQueue;

    const sendMessage = yield* Azure.Storage.SendQueueMessage(sendQueue);
    const receiveMessages = yield* Azure.Storage.ReceiveQueueMessages(receiveQueue);
    const deleteMessage = yield* Azure.Storage.DeleteQueueMessage(deleteQueue);
    const updateMessage = yield* Azure.Storage.UpdateQueueMessage(updateQueue);
    const peekMessages = yield* Azure.Storage.PeekQueueMessages(peekQueue);
    const clearMessages = yield* Azure.Storage.ClearQueueMessages(clearQueue);
    const getQueueProperties = yield* Azure.Storage.GetQueueProperties(propertiesQueue);
    const getAccessPolicy = yield* Azure.Storage.GetQueueAccessPolicy(aclGetQueue);
    const setAccessPolicy = yield* Azure.Storage.SetQueueAccessPolicy(aclSetQueue);
    const listQueues = yield* Azure.Storage.ListQueues(account);
    const getServiceProperties = yield* Azure.Storage.GetQueueServiceProperties(account);
    const getServiceStatistics = yield* Azure.Storage.GetQueueServiceStatistics(account);
    const read = yield* Azure.Storage.QueueRead(readQueue);
    const write = yield* Azure.Storage.QueueWrite(writeQueue);
    const readWrite = yield* Azure.Storage.QueueReadWrite(readWriteQueue);
    const processor = yield* Azure.Storage.QueueReceive(processorQueue);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const message = { messageId: param("id"), popReceipt: param("pop") };
        switch (url.pathname) {
          // Per-operation bindings.
          case "/send":
            return yield* respond(
              Effect.map(sendMessage({ MessageText: param("text") }), ([sent]) => sent),
            );
          case "/receive":
            return yield* respond(receiveMessages({ numofmessages: 32, visibilitytimeout: 300 }));
          case "/delete":
            return yield* respond(
              deleteMessage({ messageid: message.messageId, popreceipt: message.popReceipt }),
            );
          case "/update":
            return yield* respond(
              Effect.map(
                updateMessage({
                  messageid: message.messageId,
                  popreceipt: message.popReceipt,
                  MessageText: param("text"),
                  visibilitytimeout: 0,
                }),
                (res) => ({ popReceipt: res.xMsPopreceipt }),
              ),
            );
          case "/peek":
            return yield* respond(peekMessages({ numofmessages: 32 }));
          case "/clear":
            return yield* respond(clearMessages());
          case "/properties":
            return yield* respond(
              Effect.map(getQueueProperties(), (res) => ({
                count: res.xMsApproximateMessagesCount,
                purpose: res.metadata?.purpose,
              })),
            );
          case "/acl/get":
            return yield* respond(getAccessPolicy());
          case "/acl/set":
            return yield* respond(
              setAccessPolicy({
                body: [
                  {
                    Id: "from-function",
                    AccessPolicy: {
                      Start: "2026-01-01T00:00:00Z",
                      Expiry: "2030-01-01T00:00:00Z",
                      Permission: "rp",
                    },
                  },
                ],
              }),
            );
          case "/queues":
            return yield* respond(
              Effect.map(listQueues({ prefix: param("prefix") || undefined }), (page) =>
                page.QueueItems.map((q) => q.Name),
              ),
            );
          case "/service/properties":
            return yield* respond(getServiceProperties());
          case "/service/stats":
            return yield* respond(getServiceStatistics());

          // Read / Write / ReadWrite / Receive clients.
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const properties = yield* read.getProperties();
                const peeked = yield* read.peek(32);
                return { ...properties, texts: peeked.map((m) => m.text) };
              }),
            );
          case "/write/send":
            return yield* respond(write.send(param("text")));
          case "/write/update":
            return yield* respond(write.update(message, { text: param("text") }));
          case "/write/delete":
            return yield* respond(write.delete(message));
          case "/write/clear":
            return yield* respond(write.clear());
          case "/readwrite":
            return yield* respond(
              Effect.gen(function* () {
                const key = param("key");
                yield* readWrite.send(key);
                const [received] = yield* readWrite.receive({ maxMessages: 1 });
                const updated = yield* readWrite.update(received!, {
                  text: `${key}-updated`,
                  visibilityTimeoutSeconds: 0,
                });
                const peeked = yield* readWrite.peek(32);
                const [again] = yield* readWrite.receive({ maxMessages: 1 });
                yield* readWrite.delete(again!);
                yield* readWrite.send(`${key}-cleared`);
                yield* readWrite.clear();
                const properties = yield* readWrite.getProperties();
                return {
                  received: received?.text,
                  updatedReceipt: updated.popReceipt.length > 0,
                  peeked: peeked.map((m) => m.text),
                  again: again?.text,
                  countAfterClear: properties.approximateMessageCount,
                };
              }),
            );
          case "/processor":
            return yield* respond(
              Effect.gen(function* () {
                const peeked = yield* processor.peek(32);
                const received = yield* processor.receive({ maxMessages: 32 });
                for (const m of received) yield* processor.delete(m);
                return { peeked: peeked.map((m) => m.text), received: received.map((m) => m.text) };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Storage.SendQueueMessageHttp,
        Azure.Storage.ReceiveQueueMessagesHttp,
        Azure.Storage.DeleteQueueMessageHttp,
        Azure.Storage.UpdateQueueMessageHttp,
        Azure.Storage.PeekQueueMessagesHttp,
        Azure.Storage.ClearQueueMessagesHttp,
        Azure.Storage.GetQueuePropertiesHttp,
        Azure.Storage.GetQueueAccessPolicyHttp,
        Azure.Storage.SetQueueAccessPolicyHttp,
        Azure.Storage.ListQueuesHttp,
        Azure.Storage.GetQueueServicePropertiesHttp,
        Azure.Storage.GetQueueServiceStatisticsHttp,
        Azure.Storage.QueueReadHttp,
        Azure.Storage.QueueWriteHttp,
        Azure.Storage.QueueReadWriteHttp,
        Azure.Storage.QueueReceiveHttp,
      ),
    ),
  ),
) {}
