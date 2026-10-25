import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** The distilled request without the account the binding fills in. */
export interface CreateFileSystemRequest extends Omit<datalake.CreateFileSystemRequest, "url"> {}

/**
 * Create a Data Lake filesystem in a storage account (`FileSystem_Create`).
 * Works from any host.
 *
 * Bind it to a {@link StorageAccount} with `isHnsEnabled: true`; the
 * callable fills in the account's `dfs` endpoint.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/write` on the
 * storage account only. Storage Blob Data Contributor would also grant data
 * access to every filesystem, so the role is the
 * `Azure.Authorization.RoleDefinition` `DataLakeFileSystemCreateRole`,
 * defined once per stack at the subscription and shared by every host that
 * binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link CreateFileSystemHttp}.
 *
 * ### Creating Filesystems
 * **Example:** Create a filesystem per tenant
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Data: an Azure.Storage.StorageAccount with isHnsEnabled: true
 *     const data = yield* Data;
 *     const createFileSystem = yield* Azure.Storage.CreateFileSystem(data);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* createFileSystem({ filesystem: `tenant-${tenantId}` });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CreateFileSystemHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateFileSystem extends Binding.Service<
  CreateFileSystem,
  "Azure.Storage.CreateFileSystem",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request: CreateFileSystemRequest,
    ) => Effect.Effect<
      datalake.CreateFileSystemResponse,
      datalake.CreateFileSystemError,
      RuntimeContext
    >
  >
> {}

export const CreateFileSystem = Binding.Service<CreateFileSystem>("Azure.Storage.CreateFileSystem");
