import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/** The Service Bus namespace. Topics need the Standard tier or higher. */
export const Bus = Azure.ServiceBus.Namespace("Bus", { sku: "Standard" });

/**
 * The order queue. The API sends one message per order; the worker's
 * queue trigger receives each message once.
 */
export const Orders = Effect.gen(function* () {
  const bus = yield* Bus;
  return yield* Azure.ServiceBus.Queue("Orders", { namespace: bus.namespaceName });
});

/** The event topic. Every subscription gets its own copy of each event. */
export const Events = Effect.gen(function* () {
  const bus = yield* Bus;
  return yield* Azure.ServiceBus.Topic("Events", { namespace: bus.namespaceName });
});

const subscription = (id: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const events = yield* Events;
    return yield* Azure.ServiceBus.Subscription(id, {
      namespace: bus.namespaceName,
      topic: events.topicName,
    });
  });

/** Records every event for auditing. */
export const Audit = subscription("Audit");
/** Sends a (pretend) notification for every event. */
export const Notify = subscription("Notify");

/** Storage for the worker's results. */
export const Data = Azure.Storage.StorageAccount("Data");

/**
 * One blob per processed message: `orders/{id}`, `audit/{id}` and
 * `notify/{id}`. The worker writes them; the API reads them.
 */
export const Results = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Results", {
    storageAccount: account.storageAccountName,
  });
});

/** What the API sends to the `Orders` queue. */
export interface OrderMessage {
  id: string;
  item: string;
  quantity: number;
}

/** What the API publishes to the `Events` topic. */
export interface EventMessage {
  id: string;
  type: string;
}

/** The result kinds the worker writes, one per queue or subscription. */
export const RESULT_KINDS = ["orders", "audit", "notify"] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

/** Blob name of a message's result. */
export const resultKey = (kind: ResultKind, id: string) => `${kind}/${id}`;
