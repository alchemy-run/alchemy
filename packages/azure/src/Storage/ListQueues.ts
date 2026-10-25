import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** The `ListServiceQueuesSegment` request without the `url` the bound account supplies. */
export interface ListQueuesRequest extends Omit<queues.ListServiceQueuesSegmentRequest, "url"> {}

/**
 * List one page of the queues in an Azure Storage account (List Queues) on any host. Pass the response's `NextMarker` as `marker` to read the next page.
 *
 * Binding assigns a custom role with only the `queues/read` action
 * on the storage account.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ListQueuesHttp}.
 *
 * ### Listing Queues
 * **Example:** List queues by prefix
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: assigns the role on the account
 *     const listQueues = yield* Azure.Storage.ListQueues(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* listQueues({ prefix: "jobs-", include: ["metadata"] });
 *         return yield* HttpServerResponse.json(page.QueueItems.map((q) => q.Name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ListQueuesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListQueues extends Binding.Service<
  ListQueues,
  "Azure.Storage.ListQueues",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: ListQueuesRequest,
    ) => Effect.Effect<
      queues.ListServiceQueuesSegmentResponse,
      queues.ListServiceQueuesSegmentError,
      RuntimeContext
    >
  >
> {}

export const ListQueues = Binding.Service<ListQueues>("Azure.Storage.ListQueues");
