import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface GetFileSystemPropertiesRequest extends Omit<
  datalake.GetFileSystemPropertiesRequest,
  "url" | "filesystem"
> {}

/**
 * Read a Data Lake filesystem's properties (`FileSystem_GetProperties`).
 * Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/read` on the
 * filesystem only. Storage Blob Data Reader would also grant reading every
 * file, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakeFileSystemReadRole`, defined once per stack at the subscription
 * and shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetFileSystemPropertiesHttp}.
 *
 * ### Reading Filesystem Properties
 * **Example:** Check the hierarchical namespace
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const getFileSystemProperties = yield* Azure.Storage.GetFileSystemProperties(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { xMsNamespaceEnabled } = yield* getFileSystemProperties();
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetFileSystemPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetFileSystemProperties extends Binding.Service<
  GetFileSystemProperties,
  "Azure.Storage.GetFileSystemProperties",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request?: GetFileSystemPropertiesRequest,
    ) => Effect.Effect<
      datalake.GetFileSystemPropertiesResponse,
      datalake.GetFileSystemPropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetFileSystemProperties = Binding.Service<GetFileSystemProperties>(
  "Azure.Storage.GetFileSystemProperties",
);
