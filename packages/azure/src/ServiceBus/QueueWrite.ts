import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { WriteServiceBusQueueClient } from "./ServiceBusTypes.ts";

/**
 * Send messages, one at a time or in batches, to an Azure Service Bus queue
 * from any host. {@link QueueSend} is the same without `sendBatch`.
 *
 * Binding assigns **Azure Service Bus Data Sender**
 * (the `send/action` data action) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueWriteHttp}.
 *
 * ### Sending Messages
 * **Example:** Send one message and a batch
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     const orders = yield* Azure.ServiceBus.QueueWrite(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.send({ orderId: "42" }, { messageId: "42" });
 *         yield* orders.sendBatch([
 *           { body: { orderId: "43" } },
 *           { body: "plain text", options: { label: "note", timeToLiveSeconds: 600 } },
 *         ]);
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.QueueWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface QueueWrite extends Binding.Service<
  QueueWrite,
  "Azure.ServiceBus.QueueWrite",
  (queue: Queue) => Effect.Effect<WriteServiceBusQueueClient>
> {}

export const QueueWrite = Binding.Service<QueueWrite>("Azure.ServiceBus.QueueWrite");
