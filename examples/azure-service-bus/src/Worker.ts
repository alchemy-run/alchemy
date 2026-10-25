import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import {
  Audit,
  Notify,
  Orders,
  Results,
  resultKey,
  type EventMessage,
  type OrderMessage,
  type ResultKind,
} from "./resources.ts";

/**
 * The consumer. Each event source becomes a native `serviceBusTrigger`
 * function in this app, connected through the app's managed identity:
 *
 * - `Orders` queue: each order is received once.
 * - `Audit` and `Notify` subscriptions: each gets its own copy of every
 *   event published to the `Events` topic.
 *
 * Service Bus completes a message when the handler succeeds and abandons it
 * when the handler fails; after the entity's max delivery count (10) it
 * moves to the dead-letter queue. Results are written with `put`, so a
 * redelivered message overwrites its blob with the same values.
 */
export default class Worker extends Azure.Functions.Function<Worker>()(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const resultsContainer = yield* Results;
    const results = yield* Azure.Storage.BlobContainerWrite(resultsContainer);

    const record = (kind: ResultKind, id: string, value: object) =>
      Effect.sync(() => JSON.stringify({ ...value, processedAt: new Date().toISOString() })).pipe(
        Effect.flatMap((body) =>
          results.put(resultKey(kind, id), body, { contentType: "application/json" }),
        ),
        // The app's Storage role can take a minute to propagate after
        // the first deploy.
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 10 }),
        // A failure dies the invocation, so Service Bus redelivers.
        Effect.orDie,
        Effect.asVoid,
      );

    yield* Azure.ServiceBus.consumeQueueMessages(Orders, (message) => {
      const order = message.body as OrderMessage;
      return record("orders", order.id, {
        item: order.item,
        quantity: order.quantity,
        deliveryCount: message.deliveryCount,
      });
    });

    yield* Azure.ServiceBus.consumeSubscriptionMessages(Audit, (message) => {
      const event = message.body as EventMessage;
      return record("audit", event.id, { type: event.type, messageId: message.messageId });
    });

    yield* Azure.ServiceBus.consumeSubscriptionMessages(Notify, (message) => {
      const event = message.body as EventMessage;
      return Effect.log(`notify: ${event.type}`).pipe(
        Effect.andThen(record("notify", event.id, { type: event.type })),
      );
    });

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide([
      Azure.Functions.ServiceBusQueueEventSource,
      Azure.Functions.ServiceBusSubscriptionEventSource,
      Azure.Storage.BlobContainerWriteHttp,
    ]),
  ),
) {}
