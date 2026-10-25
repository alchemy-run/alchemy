import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";
import type { ReadServiceBusQueueClient } from "./ServiceBusTypes.ts";

/**
 * Receive and settle the messages of an Azure Service Bus queue on any
 * host: peek-lock with `receive` and then `complete`, `abandon` or
 * `renewLock`, or take a message for good with `receiveAndDelete`.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueReadHttp}.
 *
 * ### Processing a Queue
 * **Example:** Receive, process, and complete
 * ```typescript
 * export default class Processor extends Azure.Functions.Function<Processor>()(
 *   "Processor",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     const orders = yield* Azure.ServiceBus.QueueRead(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* orders.receive({ timeoutSeconds: 5 });
 *         if (message === undefined) return HttpServerResponse.text("empty");
 *         if (message.deliveryCount !== undefined && message.deliveryCount > 3) {
 *           yield* orders.complete(message);
 *         } else {
 *           yield* orders.abandon(message);
 *         }
 *         return yield* HttpServerResponse.json({ text: message.text });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.QueueReadHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface QueueRead extends Binding.Service<
  QueueRead,
  "Azure.ServiceBus.QueueRead",
  (queue: Queue) => Effect.Effect<ReadServiceBusQueueClient>
> {}

export const QueueRead = Binding.Service<QueueRead>("Azure.ServiceBus.QueueRead");
