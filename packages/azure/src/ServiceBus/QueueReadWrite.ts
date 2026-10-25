import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { ReadWriteServiceBusQueueClient } from "./ServiceBusTypes.ts";

/**
 * Send, receive, and settle the messages of an Azure Service Bus queue on
 * any host: everything {@link QueueRead} and {@link QueueWrite} do.
 *
 * Binding assigns **Azure Service Bus Data Sender** and **Azure Service Bus
 * Data Receiver** on the queue only (Azure Service Bus Data Owner would also
 * let the host manage the queue).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * roles go to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the roles to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueReadWriteHttp}.
 *
 * ### Processing a Queue
 * **Example:** Forward a message back with a retry count
 * ```typescript
 * export default class Retrier extends Azure.Functions.Function<Retrier>()(
 *   "Retrier",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     const orders = yield* Azure.ServiceBus.QueueReadWrite(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* orders.receive();
 *         if (message === undefined) return HttpServerResponse.text("empty");
 *         yield* orders.send(message.text, { properties: { retried: "true" } });
 *         yield* orders.complete(message);
 *         return HttpServerResponse.text("requeued");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.QueueReadWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface QueueReadWrite extends Binding.Service<
  QueueReadWrite,
  "Azure.ServiceBus.QueueReadWrite",
  (queue: Queue) => Effect.Effect<ReadWriteServiceBusQueueClient>
> {}

export const QueueReadWrite = Binding.Service<QueueReadWrite>("Azure.ServiceBus.QueueReadWrite");
