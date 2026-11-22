import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `PeekLockMessage` request without the `namespaceName` and `queueName` the bound queue supplies. */
export interface PeekLockMessageRequest extends Omit<
  messaging.PeekLockMessageRequest,
  "namespaceName" | "queueName"
> {}

/**
 * Receive and lock the next message of an Azure Service Bus queue (Peek-Lock
 * Message) on any host. Settle it with {@link CompleteMessage},
 * {@link UnlockMessage} or {@link RenewMessageLock} using the lock URI in
 * `location`; without a message within `timeout` seconds the response has no
 * `body`.
 *
 * Binding assigns **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link PeekLockMessageHttp}.
 *
 * ### Receiving Messages
 * **Example:** Peek-lock the next message
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue only
 *     const peekLock = yield* Azure.ServiceBus.PeekLockMessage(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* peekLock({ timeout: 5 });
 *         return yield* HttpServerResponse.json({ text: message.body && new TextDecoder().decode(message.body), location: message.location });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.PeekLockMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface PeekLockMessage extends Binding.Service<
  PeekLockMessage,
  "Azure.ServiceBus.PeekLockMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: PeekLockMessageRequest,
    ) => Effect.Effect<
      messaging.PeekLockMessageResponse,
      messaging.PeekLockMessageError,
      RuntimeContext
    >
  >
> {}

export const PeekLockMessage = Binding.Service<PeekLockMessage>("Azure.ServiceBus.PeekLockMessage");
