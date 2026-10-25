import type * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { EventHub } from "./EventHub.ts";

/** A `SendEventBatch` request; the bound event hub supplies the namespace and name. */
export interface SendEventBatchRequest extends Omit<
  messaging.SendEventBatchRequest,
  "namespaceName" | "eventHubName"
> {}

/** Runtime callable of {@link SendEventBatch}. */
export type SendEventBatchClient = (
  request: SendEventBatchRequest,
) => Effect.Effect<messaging.SendEventBatchResponse, messaging.SendEventBatchError, RuntimeContext>;

/**
 * Send several events to an Azure Event Hub in one request from any host.
 * A batch goes to one partition: every event must name the same
 * `brokerProperties.partitionKey`, or none (`BatchPartitionKeyMismatch`
 * otherwise). The whole batch counts against the hub's maximum event size
 * (`MessageTooLarge`).
 *
 * Binding assigns **Azure Event Hubs Data Sender** on the event hub only;
 * its only data action is `send` (its one action is the control-plane
 * `eventhubs/read`). On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group,
 * VM, or AKS workload identity) the role goes to that identity; any other
 * host (a Cloudflare Worker, an AWS Lambda) gets an Entra service principal
 * and client secret (see `AzureBindings`). Provide {@link SendEventBatchHttp}.
 *
 * ### Sending a Batch
 * **Example:** Send readings for one device
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: assigns Azure Event Hubs Data Sender on the event hub
 *     const sendBatch = yield* Azure.EventHub.SendEventBatch(telemetry);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the namespace and event hub name are filled in
 *         yield* sendBatch({
 *           events: readings.map((reading) => ({
 *             body: JSON.stringify(reading),
 *             brokerProperties: { partitionKey: "d1" },
 *             userProperties: { source: "api" },
 *           })),
 *         });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SendEventBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category EventHub
 */
export interface SendEventBatch extends Binding.Service<
  SendEventBatch,
  "Azure.EventHub.SendEventBatch",
  (hub: EventHub) => Effect.Effect<SendEventBatchClient>
> {}

export const SendEventBatch = Binding.Service<SendEventBatch>("Azure.EventHub.SendEventBatch");
