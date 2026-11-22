import type * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

/** A `SendEvent` request; the bound event hub supplies the namespace and name. */
export interface SendEventRequest extends Omit<
  messaging.SendEventRequest,
  "namespaceName" | "eventHubName"
> {}

/** Runtime callable of {@link SendEvent}. */
export type SendEventClient = (
  request: SendEventRequest,
) => Effect.Effect<messaging.SendEventResponse, messaging.SendEventError, RuntimeContext>;

/**
 * Send one event to an Azure Event Hub from any host. Events with the same
 * `brokerProperties.partitionKey` land in the same partition; without one,
 * Event Hubs picks a partition. Each `userProperties` entry becomes a custom
 * event property.
 *
 * Over HTTP every request header Event Hubs does not reserve becomes a
 * custom property too, so the event also carries transport headers such as
 * `traceparent`.
 *
 * Binding assigns **Azure Event Hubs Data Sender** on the event hub only;
 * its only data action is `send` (its one action is the control-plane
 * `eventhubs/read`). On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group,
 * VM, or AKS workload identity) the role goes to that identity; any other
 * host (a Cloudflare Worker, an AWS Lambda) gets an Entra service principal
 * and client secret (see `AzureBindings`). Provide {@link SendEventHttp}.
 *
 * ### Sending an Event
 * **Example:** Send a reading from a Function
 * ```typescript
 * // Telemetry: a module-scope Azure.EventHub.EventHub declaration
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const telemetry = yield* Telemetry;
 *     // init: assigns Azure Event Hubs Data Sender on the event hub only
 *     const sendEvent = yield* Azure.EventHub.SendEvent(telemetry);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the namespace and event hub name are filled in
 *         yield* sendEvent({
 *           body: JSON.stringify({ deviceId: "d1", temperature: 21 }),
 *           contentType: "application/json",
 *           brokerProperties: { partitionKey: "d1" },
 *           userProperties: { source: "api" },
 *         });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SendEventHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface SendEvent extends Binding.Service<
  SendEvent,
  "Azure.EventHub.SendEvent",
  (hub: EventHub) => Effect.Effect<SendEventClient>
> {}

export const SendEvent = Binding.Service<SendEvent>("Azure.EventHub.SendEvent");
