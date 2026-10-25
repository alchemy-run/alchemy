import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** The `GetServiceProperties` request without the `url` the bound account supplies. */
export interface GetQueueServicePropertiesRequest extends Omit<
  queues.GetServicePropertiesRequest,
  "url"
> {}

/**
 * Read the queue service properties of an Azure Storage account (logging, metrics, CORS) on any host.
 *
 * Binding assigns a custom role with only the `queueServices/read` action
 * on the storage account.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetQueueServicePropertiesHttp}.
 *
 * ### Reading Queue Service Properties
 * **Example:** Read the CORS rules
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Data;
 *     // init: assigns the role on the account
 *     const getServiceProperties = yield* Azure.Storage.GetQueueServiceProperties(account);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const properties = yield* getServiceProperties();
 *         return yield* HttpServerResponse.json(properties.Cors ?? []);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetQueueServicePropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetQueueServiceProperties extends Binding.Service<
  GetQueueServiceProperties,
  "Azure.Storage.GetQueueServiceProperties",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: GetQueueServicePropertiesRequest,
    ) => Effect.Effect<
      queues.GetServicePropertiesResponse,
      queues.GetServicePropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetQueueServiceProperties = Binding.Service<GetQueueServiceProperties>(
  "Azure.Storage.GetQueueServiceProperties",
);
