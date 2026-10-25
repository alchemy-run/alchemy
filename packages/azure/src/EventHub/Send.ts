import type {
  SendEventBatchError,
  SendEventError,
} from "@distilled.cloud/azure/eventhubs-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

export interface EventHubSendOptions {
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
}

/**
 * Send events to an Azure Event Hub from any host.
 *
 * Binding assigns **Azure Event Hubs Data Sender** on the event hub only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). Provide {@link SendHttp}.
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
 * @binding
 * @category EventHub
 */
export interface Send extends Binding.Service<
  Send,
  "Azure.EventHub.Send",
  (hub: EventHub) => Effect.Effect<SendEventHubClient>
> {}

export const Send = Binding.Service<Send>("Azure.EventHub.Send");
