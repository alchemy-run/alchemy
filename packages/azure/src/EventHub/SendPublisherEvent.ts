import type * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

/** A `SendPublisherEvent` request; the bound event hub supplies the namespace and name. */
export interface SendPublisherEventRequest extends Omit<
  messaging.SendPublisherEventRequest,
  "namespaceName" | "eventHubName"
> {}

/** Runtime callable of {@link SendPublisherEvent}. */
export type SendPublisherEventClient = (
  request: SendPublisherEventRequest,
) => Effect.Effect<
  messaging.SendPublisherEventResponse,
  messaging.SendPublisherEventError,
  RuntimeContext
>;

/**
 * Send one event to an Azure Event Hub under a publisher name from any
 * host (`/publishers/{publisherId}/messages`).
 * Publisher endpoints need a Standard or higher namespace: on Basic the
 * send fails with `PublisherRequiresStandardTier`. Each `userProperties`
 * entry becomes a custom event property.
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
 * and client secret (see `AzureBindings`). Provide
 * {@link SendPublisherEventHttp}.
 *
 * ### Sending as a Publisher
 * **Example:** Send under a device's publisher name
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns Azure Event Hubs Data Sender on the event hub
 *     const sendAsPublisher = yield* Azure.EventHub.SendPublisherEvent(telemetry);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the namespace and event hub name are filled in
 *         yield* sendAsPublisher({ publisherId: "device-1", body: "online" });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SendPublisherEventHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface SendPublisherEvent extends Binding.Service<
  SendPublisherEvent,
  "Azure.EventHub.SendPublisherEvent",
  (hub: EventHub) => Effect.Effect<SendPublisherEventClient>
> {}

export const SendPublisherEvent = Binding.Service<SendPublisherEvent>(
  "Azure.EventHub.SendPublisherEvent",
);
