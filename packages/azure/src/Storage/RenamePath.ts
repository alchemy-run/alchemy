import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** A `Path_Create` rename inside the bound filesystem; `path` is the new name. */
export interface RenamePathRequest extends Omit<
  datalake.CreatePathRequest,
  "url" | "filesystem" | "resource" | "xMsRenameSource"
> {
  /** File or directory to rename, relative to the filesystem root. */
  source: string;
}

/**
 * Rename (move) a Data Lake file or directory inside its filesystem
 * (`Path_Create` with `x-ms-rename-source`). Works from any host. A
 * directory rename is atomic on a hierarchical namespace.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint, the filesystem name, and the rename source
 * (`/<filesystem>/<source>`, percent-encoded).
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write`
 * and `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action`
 * on the filesystem only. Storage Blob Data Contributor would also grant
 * read and delete, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathMoveRole`, defined once per stack at the subscription and
 * shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link RenamePathHttp}.
 *
 * ### Renaming Paths
 * **Example:** Publish a staged directory
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const renamePath = yield* Azure.Storage.RenamePath(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* renamePath({ source: "staging/2026-10-24", path: "published/2026-10-24" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.RenamePathHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface RenamePath extends Binding.Service<
  RenamePath,
  "Azure.Storage.RenamePath",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: RenamePathRequest,
    ) => Effect.Effect<datalake.CreatePathResponse, datalake.CreatePathError, RuntimeContext>
  >
> {}

export const RenamePath = Binding.Service<RenamePath>("Azure.Storage.RenamePath");
