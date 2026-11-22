import type {
  SendEventBatchError,
  SendEventError,
  SendPartitionEventError,
  SendPublisherEventError,
} from "@distilled.cloud/azure/eventhubs-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

/** Custom properties of an event, one per key. */
export interface EventHubEventOptions {
  /**
   * Custom event properties, one string value per key. Consumers see them
   * as the event's application properties.
   * @default no custom properties
   */
  properties?: Record<string, string>;
}

/** Options of `send` and `sendBatch`. */
export interface EventHubSendOptions extends EventHubEventOptions {
  /**
   * Route all events with this key to the same partition, in send order.
   * @default none (Event Hubs picks a partition)
   */
  partitionKey?: string;
}

/** Send-only client for one event hub. */
export interface SendEventHubClient {
  /**
   * Send one event. A string is sent as `text/plain`; an object is
   * JSON-encoded and sent as `application/json`.
   */
  send(
    event: string | object,
    options?: EventHubSendOptions,
  ): Effect.Effect<void, SendEventError, RuntimeContext>;
  /**
   * Send a batch of events in one request; objects are JSON-encoded. Every
   * event gets the same `options`. An empty array sends nothing. The whole
   * batch counts against the hub's maximum event size (`MessageTooLarge`).
   */
  sendBatch(
    events: ReadonlyArray<string | object>,
    options?: EventHubSendOptions,
  ): Effect.Effect<void, SendEventBatchError, RuntimeContext>;
  /**
   * Send one event to one partition. `partitionId` is one of the hub's
   * `partitionIds` (`"0"`, `"1"`, …); any other value fails with
   * `InvalidPartition`.
   */
  sendToPartition(
    partitionId: string,
    event: string | object,
    options?: EventHubEventOptions,
  ): Effect.Effect<void, SendPartitionEventError, RuntimeContext>;
  /**
   * Send one event under a publisher name, e.g. a device ID. Needs a
   * `Standard` or higher namespace (`PublisherRequiresStandardTier` on
   * `Basic`).
   */
  sendAsPublisher(
    publisherId: string,
    event: string | object,
    options?: EventHubEventOptions,
  ): Effect.Effect<void, SendPublisherEventError, RuntimeContext>;
}

/**
 * Send events to an Azure Event Hub from any host: one event, a batch, to
 * one partition, or under a publisher name. For the raw requests, bind the
 * per-operation `SendEvent`, `SendEventBatch`, `SendPartitionEvent`, or
 * `SendPublisherEvent` instead. Event Hubs has no HTTP receive API (it reads
 * over AMQP), so there is no read binding: consume events with
 * `Azure.EventHub.consumeEvents`.
 * `sendAsPublisher` needs a Standard or higher namespace
 * (`PublisherRequiresStandardTier` on Basic). Single-event sends also carry
 * the request's unreserved HTTP headers (such as `traceparent`) as custom
 * properties; `sendBatch` carries only `properties`.
 *
 * Binding assigns **Azure Event Hubs Data Sender** on the event hub only;
 * its only data action is `send` (its one action is the control-plane
 * `eventhubs/read`). On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group,
 * VM, or AKS workload identity) the role goes to that identity. On any
 * other host (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra
 * service principal for the host, assigns the role to it, and binds its
 * client secret into the host's env (see `AzureBindings`). Provide
 * {@link SendHttp}.
 *
 * ### Sending Events
 * **Example:** Send a reading from a Function
 * ```typescript
 * // Readings: a module-scope Azure.EventHub.EventHub declaration
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const hub = yield* Readings;
 *     // init: assigns Azure Event Hubs Data Sender on the event hub only
 *     const readings = yield* Azure.EventHub.Send(hub);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* readings.send(
 *           { deviceId: "d1", temperature: 21 },
 *           { partitionKey: "d1" },
 *         );
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SendHttp)),
 * ) {}
 * ```
 *
 * **Example:** Send a batch with custom properties
 * ```typescript
 * // runtime, inside the host above
 * yield* readings.sendBatch(
 *   [
 *     { deviceId: "d1", temperature: 21 },
 *     { deviceId: "d1", temperature: 22 },
 *   ],
 *   { partitionKey: "d1", properties: { source: "gateway" } },
 * );
 * ```
 *
 * ### Choosing the Partition
 * **Example:** Send to one partition or as a publisher
 * ```typescript
 * // runtime, inside the host above
 * yield* readings.sendToPartition("0", { kind: "rebalance" });
 * yield* readings.sendAsPublisher("device-1", { kind: "online" });
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface Send extends Binding.Service<
  Send,
  "Azure.EventHub.Send",
  (hub: EventHub) => Effect.Effect<SendEventHubClient>
> {}

export const Send = Binding.Service<Send>("Azure.EventHub.Send");
