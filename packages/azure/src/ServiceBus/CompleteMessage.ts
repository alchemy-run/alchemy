import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `CompleteMessage` request without the `namespaceName` and `queueName` the bound queue supplies. */
export interface CompleteMessageRequest extends Omit<
  messaging.CompleteMessageRequest,
  "namespaceName" | "queueName"
> {}

/**
 * Complete a peek-locked message of an Azure Service Bus queue (Delete
 * Message) on any host: delete it after processing succeeded. Fails
 * `MessageLockLost` when the lock expired or the message was already settled.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link CompleteMessageHttp}.
 *
 * ### Settling Messages
 * **Example:** Complete a locked message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue only
 *     const completeMessage = yield* Azure.ServiceBus.CompleteMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // messageId and lockToken: the lock URI (`location`) of a peek-locked message
 *         yield* completeMessage({ messageId, lockToken });
 *         return yield* HttpServerResponse.json({ completed: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.CompleteMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface CompleteMessage extends Binding.Service<
  CompleteMessage,
  "Azure.ServiceBus.CompleteMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: CompleteMessageRequest,
    ) => Effect.Effect<
      messaging.CompleteMessageResponse,
      messaging.CompleteMessageError,
      RuntimeContext
    >
  >
> {}

export const CompleteMessage = Binding.Service<CompleteMessage>("Azure.ServiceBus.CompleteMessage");
