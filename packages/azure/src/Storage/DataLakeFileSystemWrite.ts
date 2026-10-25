import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";
import type {
  DataLakeFileSystemError,
  DeleteDataLakePathOptions,
  WriteDataLakeFileOptions,
} from "./DataLakeFileSystemTypes.ts";

/** Write-only client for one Data Lake filesystem. */
export interface WriteDataLakeFileSystemClient {
  /** Create a directory (and any missing parents). */
  createDirectory(path: string): Effect.Effect<void, DataLakeFileSystemError, RuntimeContext>;
  /** Create or overwrite a file with `body`. */
  write(
    path: string,
    body: string | Uint8Array,
    options?: WriteDataLakeFileOptions,
  ): Effect.Effect<{ etag: string | undefined }, DataLakeFileSystemError, RuntimeContext>;
  /** Rename a file or directory inside the filesystem. */
  rename(
    source: string,
    destination: string,
  ): Effect.Effect<void, DataLakeFileSystemError, RuntimeContext>;
  /** Delete a file or directory; deleting a missing path succeeds. */
  delete(
    path: string,
    options?: DeleteDataLakePathOptions,
  ): Effect.Effect<void, DataLakeFileSystemError, RuntimeContext>;
}

/**
 * Write access to an Azure Data Lake Storage Gen2 filesystem from any host:
 * create directories, write files, rename, and delete. Built on
 * {@link CreatePath}, {@link AppendPathData}, {@link FlushPathData},
 * {@link RenamePath}, and {@link DeletePath}.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`).
 *
 * Binding assigns a custom role with exactly the `blobs/write`,
 * `blobs/delete`, `blobs/move/action`, and `blobs/add/action` data actions
 * (under `Microsoft.Storage/storageAccounts/blobServices/containers`) on
 * the filesystem only. Storage Blob Data Contributor would also grant
 * read, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathWriteOnlyRole`, defined once per stack at the subscription
 * and shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link DataLakeFileSystemWriteHttp}.
 *
 * ### Writing Files
 * **Example:** Write a report
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const files = yield* Azure.Storage.DataLakeFileSystemWrite(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* files.createDirectory("reports");
 *         yield* files.write("reports/latest.json", JSON.stringify({ ok: true }), {
 *           contentType: "application/json",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DataLakeFileSystemWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** Rename, then delete a directory tree
 * ```typescript
 * yield* files.rename("staging/run-42", "archive/run-42");
 * yield* files.delete("archive", { recursive: true });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DataLakeFileSystemWrite extends Binding.Service<
  DataLakeFileSystemWrite,
  "Azure.Storage.DataLakeFileSystemWrite",
  (fileSystem: BlobContainer) => Effect.Effect<WriteDataLakeFileSystemClient>
> {}

export const DataLakeFileSystemWrite = Binding.Service<DataLakeFileSystemWrite>(
  "Azure.Storage.DataLakeFileSystemWrite",
);
