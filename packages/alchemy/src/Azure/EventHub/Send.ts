import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type {
  AzureDataPlaneError,
  AzureManagedIdentityError,
} from "../Binding.ts";
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
  ): Effect.Effect<
    void,
    AzureDataPlaneError | AzureManagedIdentityError,
    RuntimeContext
  >;
  /** Send a batch of events in one request. */
  sendBatch(
    events: ReadonlyArray<string | object>,
    options?: EventHubSendOptions,
  ): Effect.Effect<
    void,
    AzureDataPlaneError | AzureManagedIdentityError,
    RuntimeContext
  >;
}

/**
 * Send events to an Azure Event Hub from a Container App or Function App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Azure Event Hubs Data Sender** on the event hub only. Provide
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
 * @binding
 * @category EventHub
 */
export interface Send extends Binding.Service<
  Send,
  "Azure.EventHub.Send",
  (hub: EventHub) => Effect.Effect<SendEventHubClient>
> {}

export const Send = Binding.Service<Send>("Azure.EventHub.Send");
