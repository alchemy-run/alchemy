import type * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `RenewMessageLock` request without the `namespaceName` and `queueName` the bound queue supplies. */
export interface RenewMessageLockRequest extends Omit<
  messaging.RenewMessageLockRequest,
  "namespaceName" | "queueName"
> {}

/**
 * Extend the lock on a peek-locked message of an Azure Service Bus queue
 * (Renew-Lock for a Message) on any host, by the queue's lock duration. Fails
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
 * Provide {@link RenewMessageLockHttp}.
 *
 * ### Settling Messages
 * **Example:** Keep a long-running message locked
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     // init: assigns the role on the queue only
 *     const renewLock = yield* Azure.ServiceBus.RenewMessageLock(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // messageId and lockToken: the lock URI (`location`) of a peek-locked message
 *         yield* renewLock({ messageId, lockToken });
 *         return yield* HttpServerResponse.json({ renewed: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.RenewMessageLockHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ServiceBus
 */
export interface RenewMessageLock extends Binding.Service<
  RenewMessageLock,
  "Azure.ServiceBus.RenewMessageLock",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: RenewMessageLockRequest,
    ) => Effect.Effect<
      messaging.RenewMessageLockResponse,
      messaging.RenewMessageLockError,
      RuntimeContext
    >
  >
> {}

export const RenewMessageLock = Binding.Service<RenewMessageLock>(
  "Azure.ServiceBus.RenewMessageLock",
);
