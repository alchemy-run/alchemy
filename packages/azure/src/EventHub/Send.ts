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
  /** Custom event properties. */
  properties?: Record<string, string>;
}

export interface EventHubSendOptions extends EventHubEventOptions {
  /** Route all events with this key to the same partition. */
  partitionKey?: string;
}

/** Send-only client for one event hub. */
export interface SendEventHubClient {
  /** Send one event; objects are JSON-encoded. */
  send(
    event: string | object,
    options?: EventHubSendOptions,
  ): Effect.Effect<void, SendEventError, RuntimeContext>;
  /** Send a batch of events in one request. */
  sendBatch(
    events: ReadonlyArray<string | object>,
    options?: EventHubSendOptions,
  ): Effect.Effect<void, SendEventBatchError, RuntimeContext>;
  /** Send one event to one partition (`"0"`, `"1"`, …). */
  sendToPartition(
    partitionId: string,
    event: string | object,
    options?: EventHubEventOptions,
  ): Effect.Effect<void, SendPartitionEventError, RuntimeContext>;
  /** Send one event under a publisher name (Standard or higher namespaces). */
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
 * **Example:** Send telemetry
 * ```typescript
 * // init
 * const telemetry = yield* Azure.EventHub.Send(hub);
 *
 * // runtime
 * yield* telemetry.send({ deviceId, temperature }, { partitionKey: deviceId });
 * ```
 *
 * **Example:** Send a batch with custom properties
 * ```typescript
 * yield* telemetry.sendBatch(readings, { properties: { source: "gateway" } });
 * ```
 *
 * ### Choosing the Partition
 * **Example:** Send to one partition or as a publisher
 * ```typescript
 * yield* telemetry.sendToPartition("0", { kind: "rebalance" });
 * yield* telemetry.sendAsPublisher(deviceId, { kind: "online" });
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
