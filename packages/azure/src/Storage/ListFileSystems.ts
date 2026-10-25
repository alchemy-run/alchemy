import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** The distilled request without the account the binding fills in. */
export interface ListFileSystemsRequest extends Omit<
  datalake.ListServiceFileSystemsRequest,
  "url"
> {}

/**
 * List the Data Lake filesystems of a storage account
 * (`Service_ListFileSystems`). Works from any host.
 *
 * Bind it to a {@link StorageAccount} with `isHnsEnabled: true`; the
 * callable fills in the account's `dfs` endpoint.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/read` on the
 * storage account only. Storage Blob Data Reader would also grant reading
 * every file, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakeFileSystemReadRole`, defined once per stack at the subscription
 * and shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link ListFileSystemsHttp}.
 *
 * ### Listing Filesystems
 * **Example:** List tenant filesystems
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Data: an Azure.Storage.StorageAccount with isHnsEnabled: true
 *     const data = yield* Data;
 *     const listFileSystems = yield* Azure.Storage.ListFileSystems(data);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { filesystems, xMsContinuation } = yield* listFileSystems({ prefix: "tenant-" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ListFileSystemsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListFileSystems extends Binding.Service<
  ListFileSystems,
  "Azure.Storage.ListFileSystems",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: ListFileSystemsRequest,
    ) => Effect.Effect<
      datalake.ListServiceFileSystemsResponse,
      datalake.ListServiceFileSystemsError,
      RuntimeContext
    >
  >
> {}

export const ListFileSystems = Binding.Service<ListFileSystems>("Azure.Storage.ListFileSystems");
