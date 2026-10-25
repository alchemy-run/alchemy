import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `UnlockMessage` request without the `namespaceName` and `queueName` the bound queue supplies. */
export interface UnlockMessageRequest extends Omit<
  messaging.UnlockMessageRequest,
  "namespaceName" | "queueName"
> {}

/**
 * Release the lock on a peek-locked message of an Azure Service Bus queue
 * (Unlock Message) on any host, so it is delivered again. Fails
 * `MessageLockLost` when the lock expired.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link UnlockMessageHttp}.
 *
 * ### Settling Messages
 * **Example:** Abandon a locked message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue only
 *     const unlockMessage = yield* Azure.ServiceBus.UnlockMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // messageId and lockToken: the lock URI (`location`) of a peek-locked message
 *         yield* unlockMessage({ messageId, lockToken });
 *         return yield* HttpServerResponse.json({ unlocked: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.UnlockMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface UnlockMessage extends Binding.Service<
  UnlockMessage,
  "Azure.ServiceBus.UnlockMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: UnlockMessageRequest,
    ) => Effect.Effect<
      messaging.UnlockMessageResponse,
      messaging.UnlockMessageError,
      RuntimeContext
    >
  >
> {}

export const UnlockMessage = Binding.Service<UnlockMessage>("Azure.ServiceBus.UnlockMessage");
