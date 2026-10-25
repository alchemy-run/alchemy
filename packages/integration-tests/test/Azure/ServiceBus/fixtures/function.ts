import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
// TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the Service Bus binding fixture consumes. Module-scope so the
// test can yield the same declarations. Standard: topics need it.
export const Bus = Azure.ServiceBus.Namespace("SbBindingsBus", { sku: "Standard" });

const queue = (id: string, lockDuration?: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    return yield* Azure.ServiceBus.Queue(id, { namespace: bus.namespaceName, lockDuration });
  });

const topic = (id: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    return yield* Azure.ServiceBus.Topic(id, { namespace: bus.namespaceName });
  });

/** A topic with one subscription: the subscription receives every message. */
const subscription = (id: string, lockDuration?: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const source = yield* topic(`${id}Topic`);
    return yield* Azure.ServiceBus.Subscription(id, {
      namespace: bus.namespaceName,
      topic: source.topicName,
      lockDuration,
    });
  });

// One entity per binding, so concurrent tests never see each other's messages.
export const SendQueue = queue("SbSendQueue");
export const SendTopic = topic("SbSendSubTopic");
export const SendTopicSub = Effect.gen(function* () {
  const bus = yield* Bus;
  const source = yield* SendTopic;
  return yield* Azure.ServiceBus.Subscription("SbSendSub", {
    namespace: bus.namespaceName,
    topic: source.topicName,
  });
});
export const BatchQueue = queue("SbBatchQueue");
// The test holds these locks across a Function call.
export const PeekLockQueue = queue("SbPeekLockQueue", "PT5M");
export const ReceiveDeleteQueue = queue("SbReceiveDeleteQueue");
export const CompleteQueue = queue("SbCompleteQueue", "PT5M");
export const UnlockQueue = queue("SbUnlockQueue", "PT5M");
// Short locks: the route proves a renewal by completing after the first lock expired.
export const RenewQueue = queue("SbRenewQueue", "PT5S");
export const PeekLockSub = subscription("SbPeekLockSub", "PT5M");
export const ReceiveDeleteSub = subscription("SbReceiveDeleteSub");
export const CompleteSub = subscription("SbCompleteSub", "PT5M");
export const UnlockSub = subscription("SbUnlockSub", "PT5M");
export const RenewSub = subscription("SbRenewSub", "PT5S");
export const ReadQueue = queue("SbReadQueue");
export const WriteQueue = queue("SbWriteQueue");
export const ReadWriteQueue = queue("SbReadWriteQueue");
export const QueueSendQueue = queue("SbQueueSendQueue");
export const WriteTopic = topic("SbWriteSubTopic");
export const WriteTopicSub = Effect.gen(function* () {
  const bus = yield* Bus;
  const source = yield* WriteTopic;
  return yield* Azure.ServiceBus.Subscription("SbWriteSub", {
    namespace: bus.namespaceName,
    topic: source.topicName,
  });
});
export const ReadSub = subscription("SbReadSub");

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** Fail (so the caller retries) until a receive returned a message. */
const some = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) =>
  Effect.flatMap(effect, (value) =>
    value === undefined
      ? Effect.fail("no message within the timeout" as const)
      : Effect.succeed(value),
  );

const decode = (body: Uint8Array | undefined) =>
  body === undefined ? undefined : new TextDecoder().decode(body);

/** `.../messages/{reference}/{lockToken}` → the reference and the token. */
const lockOf = (location: string | undefined) => {
  const segments = location === undefined ? [] : new URL(location).pathname.split("/");
  return { messageId: segments.at(-2) ?? "", lockToken: segments.at(-1) ?? "" };
};

/**
 * Effect-native Azure Function with one route per `servicebus-messaging`
 * binding. Routes answer `{ ok, result | error }` with a 500 on error, so a
 * caller retries through role propagation and a real failure shows the
 * Azure error.
 */
export default class ServiceBusFunction extends Azure.Functions.Function<ServiceBusFunction>()(
  "ServiceBusBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const sendQueue = yield* SendQueue;
    const sendTopic = yield* SendTopic;
    const batchQueue = yield* BatchQueue;
    const peekLockQueue = yield* PeekLockQueue;
    const receiveDeleteQueue = yield* ReceiveDeleteQueue;
    const completeQueue = yield* CompleteQueue;
    const unlockQueue = yield* UnlockQueue;
    const renewQueue = yield* RenewQueue;
    const peekLockSub = yield* PeekLockSub;
    const receiveDeleteSub = yield* ReceiveDeleteSub;
    const completeSub = yield* CompleteSub;
    const unlockSub = yield* UnlockSub;
    const renewSub = yield* RenewSub;
    const readQueue = yield* ReadQueue;
    const writeQueue = yield* WriteQueue;
    const readWriteQueue = yield* ReadWriteQueue;
    const queueSendQueue = yield* QueueSendQueue;
    const writeTopic = yield* WriteTopic;
    const readSub = yield* ReadSub;

    const sendToQueue = yield* Azure.ServiceBus.SendMessage(sendQueue);
    const sendToTopic = yield* Azure.ServiceBus.SendMessage(sendTopic);
    const sendBatch = yield* Azure.ServiceBus.SendMessageBatch(batchQueue);
    const peekLock = yield* Azure.ServiceBus.PeekLockMessage(peekLockQueue);
    const receiveAndDelete = yield* Azure.ServiceBus.ReceiveAndDeleteMessage(receiveDeleteQueue);
    const complete = yield* Azure.ServiceBus.CompleteMessage(completeQueue);
    const unlock = yield* Azure.ServiceBus.UnlockMessage(unlockQueue);
    const renewPeekLock = yield* Azure.ServiceBus.PeekLockMessage(renewQueue);
    const renew = yield* Azure.ServiceBus.RenewMessageLock(renewQueue);
    const renewComplete = yield* Azure.ServiceBus.CompleteMessage(renewQueue);
    const subPeekLock = yield* Azure.ServiceBus.PeekLockSubscriptionMessage(peekLockSub);
    const subReceiveAndDelete =
      yield* Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessage(receiveDeleteSub);
    const subComplete = yield* Azure.ServiceBus.CompleteSubscriptionMessage(completeSub);
    const subUnlock = yield* Azure.ServiceBus.UnlockSubscriptionMessage(unlockSub);
    const subRenewPeekLock = yield* Azure.ServiceBus.PeekLockSubscriptionMessage(renewSub);
    const subRenew = yield* Azure.ServiceBus.RenewSubscriptionMessageLock(renewSub);
    const subRenewComplete = yield* Azure.ServiceBus.CompleteSubscriptionMessage(renewSub);
    const read = yield* Azure.ServiceBus.QueueRead(readQueue);
    const write = yield* Azure.ServiceBus.QueueWrite(writeQueue);
    const readWrite = yield* Azure.ServiceBus.QueueReadWrite(readWriteQueue);
    const queueSend = yield* Azure.ServiceBus.QueueSend(queueSendQueue);
    const topicWrite = yield* Azure.ServiceBus.TopicWrite(writeTopic);
    const subscriptionRead = yield* Azure.ServiceBus.SubscriptionRead(readSub);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const settle = {
          messageId: url.searchParams.get("ref") ?? "",
          lockToken: url.searchParams.get("lock") ?? "",
        };
        switch (url.pathname) {
          case "/hello":
            return HttpServerResponse.text("hello");

          // Per-operation bindings.
          case "/send": {
            const send = url.searchParams.get("to") === "topic" ? sendToTopic : sendToQueue;
            return yield* respond(
              send({
                body: JSON.stringify({ id }),
                contentType: "application/json",
                brokerProperties: { messageId: id, label: "send" },
                customProperties: { priority: "high" },
              }),
            );
          }
          case "/send-batch":
            return yield* respond(
              sendBatch({
                messages: [
                  { body: `${id}-1`, brokerProperties: { label: "first" } },
                  { body: `${id}-2`, userProperties: { position: "second" } },
                ],
              }),
            );
          case "/peek-lock":
            return yield* respond(
              Effect.map(
                some(Effect.map(peekLock({ timeout: 10 }), (m) => (m.body ? m : undefined))),
                (m) => ({ text: decode(m.body), location: m.location }),
              ),
            );
          case "/receive-delete":
            return yield* respond(
              Effect.map(
                some(
                  Effect.map(receiveAndDelete({ timeout: 10 }), (m) => (m.body ? m : undefined)),
                ),
                (m) => ({ text: decode(m.body), messageId: m.brokerProperties?.messageId }),
              ),
            );
          case "/complete":
            return yield* respond(complete(settle));
          case "/unlock":
            return yield* respond(unlock(settle));
          case "/renew":
            return yield* respond(
              Effect.gen(function* () {
                const m = yield* some(
                  Effect.map(renewPeekLock({ timeout: 10 }), (r) => (r.body ? r : undefined)),
                );
                const lock = lockOf(m.location);
                // Renew before, and complete after, the first 5-second lock expires.
                yield* Effect.sleep("3 seconds");
                yield* renew(lock);
                yield* Effect.sleep("3 seconds");
                yield* renewComplete(lock);
                return { text: decode(m.body) };
              }),
            );
          case "/sub/peek-lock":
            return yield* respond(
              Effect.map(
                some(Effect.map(subPeekLock({ timeout: 10 }), (m) => (m.body ? m : undefined))),
                (m) => ({ text: decode(m.body), location: m.location }),
              ),
            );
          case "/sub/receive-delete":
            return yield* respond(
              Effect.map(
                some(
                  Effect.map(subReceiveAndDelete({ timeout: 10 }), (m) => (m.body ? m : undefined)),
                ),
                (m) => ({ text: decode(m.body), messageId: m.brokerProperties?.messageId }),
              ),
            );
          case "/sub/complete":
            return yield* respond(subComplete(settle));
          case "/sub/unlock":
            return yield* respond(subUnlock(settle));
          case "/sub/renew":
            return yield* respond(
              Effect.gen(function* () {
                const m = yield* some(
                  Effect.map(subRenewPeekLock({ timeout: 10 }), (r) => (r.body ? r : undefined)),
                );
                const lock = lockOf(m.location);
                yield* Effect.sleep("3 seconds");
                yield* subRenew(lock);
                yield* Effect.sleep("3 seconds");
                yield* subRenewComplete(lock);
                return { text: decode(m.body) };
              }),
            );

          // Access-level bindings.
          case "/queue-read":
            return yield* respond(
              Effect.gen(function* () {
                const first = yield* some(read.receive({ timeoutSeconds: 10 }));
                yield* read.abandon(first);
                const again = yield* some(read.receive({ timeoutSeconds: 10 }));
                yield* read.renewLock(again);
                yield* read.complete(again);
                const last = yield* some(read.receiveAndDelete({ timeoutSeconds: 10 }));
                return {
                  first: [first.text, first.deliveryCount],
                  again: [again.text, again.deliveryCount],
                  last: last.text,
                };
              }),
            );
          case "/queue-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* write.send({ id }, { messageId: id, properties: { kind: "single" } });
                yield* write.sendBatch([
                  { body: `${id}-a`, options: { label: "a" } },
                  { body: { id: `${id}-b` }, options: { timeToLiveSeconds: 600 } },
                ]);
              }),
            );
          case "/queue-read-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.send(id);
                const received = yield* some(readWrite.receive({ timeoutSeconds: 10 }));
                yield* readWrite.complete(received);
                return { text: received.text };
              }),
            );
          case "/queue-send":
            return yield* respond(queueSend.send({ id }, { label: "queue-send" }));
          case "/topic-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* topicWrite.send(id, { label: "single" });
                yield* topicWrite.sendBatch([{ body: `${id}-a` }, { body: `${id}-b` }]);
              }),
            );
          case "/subscription-read":
            return yield* respond(
              Effect.gen(function* () {
                const received = yield* some(subscriptionRead.receive({ timeoutSeconds: 10 }));
                yield* subscriptionRead.complete(received);
                return { text: received.text, deliveryCount: received.deliveryCount };
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
        Azure.ServiceBus.SendMessageHttp,
        Azure.ServiceBus.SendMessageBatchHttp,
        Azure.ServiceBus.PeekLockMessageHttp,
        Azure.ServiceBus.ReceiveAndDeleteMessageHttp,
        Azure.ServiceBus.CompleteMessageHttp,
        Azure.ServiceBus.UnlockMessageHttp,
        Azure.ServiceBus.RenewMessageLockHttp,
        Azure.ServiceBus.PeekLockSubscriptionMessageHttp,
        Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessageHttp,
        Azure.ServiceBus.CompleteSubscriptionMessageHttp,
        Azure.ServiceBus.UnlockSubscriptionMessageHttp,
        Azure.ServiceBus.RenewSubscriptionMessageLockHttp,
        Azure.ServiceBus.QueueReadHttp,
        Azure.ServiceBus.QueueWriteHttp,
        Azure.ServiceBus.QueueReadWriteHttp,
        Azure.ServiceBus.QueueSendHttp,
        Azure.ServiceBus.TopicWriteHttp,
        Azure.ServiceBus.SubscriptionReadHttp,
      ),
    ),
  ),
) {}
