import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** The `GetQueueProperties` request without the `url` and `queueName` the bound queue supplies. */
export interface GetQueuePropertiesRequest extends Omit<
  queues.GetQueuePropertiesRequest,
  "url" | "queueName"
> {}

/**
 * Read the approximate message count and user metadata of an Azure Storage queue (Get Queue Metadata) on any host.
 *
 * Binding assigns a custom role with only the `queues/read` action (Storage Queue Data Reader also grants `messages/read`)
 * on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetQueuePropertiesHttp}.
 *
 * ### Reading Queue Depth
 * **Example:** Report the backlog
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Jobs;
 *     // init: assigns the role on the queue
 *     const getQueueProperties = yield* Azure.Storage.GetQueueProperties(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const properties = yield* getQueueProperties();
 *         return yield* HttpServerResponse.json({ backlog: properties.xMsApproximateMessagesCount });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetQueuePropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetQueueProperties extends Binding.Service<
  GetQueueProperties,
  "Azure.Storage.GetQueueProperties",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: GetQueuePropertiesRequest,
    ) => Effect.Effect<
      queues.GetQueuePropertiesResponse,
      queues.GetQueuePropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetQueueProperties = Binding.Service<GetQueueProperties>(
  "Azure.Storage.GetQueueProperties",
);
