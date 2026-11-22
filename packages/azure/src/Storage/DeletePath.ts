import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface DeletePathRequest extends Omit<datalake.DeletePathRequest, "url" | "filesystem"> {}

/**
 * Delete a Data Lake file or directory (`Path_Delete`). Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete`
 * on the filesystem only. Storage Blob Data Contributor would also grant
 * read and write, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathDeleteRole`, defined once per stack at the subscription and
 * shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link DeletePathHttp}.
 *
 * ### Deleting Paths
 * **Example:** Delete a directory and everything in it
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const deletePath = yield* Azure.Storage.DeletePath(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deletePath({ path: "raw/2025", recursive: true });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DeletePathHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeletePath extends Binding.Service<
  DeletePath,
  "Azure.Storage.DeletePath",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: DeletePathRequest,
    ) => Effect.Effect<datalake.DeletePathResponse, datalake.DeletePathError, RuntimeContext>
  >
> {}

export const DeletePath = Binding.Service<DeletePath>("Azure.Storage.DeletePath");
