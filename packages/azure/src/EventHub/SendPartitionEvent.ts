import type * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

/** A `SendPartitionEvent` request; the bound event hub supplies the namespace and name. */
export interface SendPartitionEventRequest extends Omit<
  messaging.SendPartitionEventRequest,
  "namespaceName" | "eventHubName"
> {}

/** Runtime callable of {@link SendPartitionEvent}. */
export type SendPartitionEventClient = (
  request: SendPartitionEventRequest,
) => Effect.Effect<
  messaging.SendPartitionEventResponse,
  messaging.SendPartitionEventError,
  RuntimeContext
>;

/**
 * Send one event to one partition of an Azure Event Hub from any host.
 * `partitionId` is one of the hub's `partitionIds` (`"0"`, `"1"`, …); any
 * other value fails with `InvalidPartition`. Each `userProperties` entry
 * becomes a custom event property.
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
 * {@link SendPartitionEventHttp}.
 *
 * ### Sending to a Partition
 * **Example:** Pin an event to partition 0
 * ```typescript
 * // Telemetry: a module-scope Azure.EventHub.EventHub declaration
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const telemetry = yield* Telemetry;
 *     // init: assigns Azure Event Hubs Data Sender on the event hub only
 *     const sendToPartition = yield* Azure.EventHub.SendPartitionEvent(telemetry);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the namespace and event hub name are filled in
 *         yield* sendToPartition({ partitionId: "0", body: "rebalance" });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SendPartitionEventHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface SendPartitionEvent extends Binding.Service<
  SendPartitionEvent,
  "Azure.EventHub.SendPartitionEvent",
  (hub: EventHub) => Effect.Effect<SendPartitionEventClient>
> {}

export const SendPartitionEvent = Binding.Service<SendPartitionEvent>(
  "Azure.EventHub.SendPartitionEvent",
);
