import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareError, PutShareFileOptions } from "./FileShareTypes.ts";

/** Write-only client for one file share. Paths are relative to the share root. */
export interface WriteFileShareClient {
  /**
   * Create or replace a file with `body`, creating missing parent
   * directories.
   */
  put(
    path: string,
    body: string | Uint8Array,
    options?: PutShareFileOptions,
  ): Effect.Effect<{ etag: string | undefined }, FileShareError, RuntimeContext>;
  /** Delete a file. Deleting a missing file succeeds. */
  delete(path: string): Effect.Effect<void, FileShareError, RuntimeContext>;
  /** Create a directory and any missing parents. An existing directory succeeds. */
  createDirectory(path: string): Effect.Effect<void, FileShareError, RuntimeContext>;
  /**
   * Delete an empty directory. Deleting a missing directory succeeds; a
   * non-empty one fails with `DirectoryNotEmpty`.
   */
  deleteDirectory(path: string): Effect.Effect<void, FileShareError, RuntimeContext>;
}

/**
 * Write access to an Azure Files share from any host, over the File REST
 * API with Microsoft Entra tokens.
 *
 * The built-in **Storage File Data Privileged Contributor** role also
 * grants read and ACL changes, so the binding assigns two custom roles on
 * the share only, each created once per stack:
 *
 * - `AzureStorageFileShareWriter`: `fileshares/files/write` and
 *   `writeFileBackupSemantics/action` (create files and directories, write
 *   ranges);
 * - `AzureStorageFileShareDeleter`: `fileshares/files/delete` and
 *   `writeFileBackupSemantics/action` (delete files and directories).
 *
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * roles go to that identity. On any other host (a Cloudflare Worker, an AWS
 * Lambda) Alchemy creates an Entra service principal for the host, assigns
 * the roles to it, and binds its client secret into the host's env (see
 * `AzureBindings`).
 * Provide {@link FileShareWriteHttp}.
 *
 * ### Writing Files
 * **Example:** Write a report
 * ```typescript
 * // init
 * const docs = yield* Azure.Storage.FileShareWrite(share);
 *
 * // runtime
 * yield* docs.put("reports/latest.json", JSON.stringify(report), {
 *   contentType: "application/json",
 * });
 * // …provided with Effect.provide(Azure.Storage.FileShareWriteHttp)
 * ```
 *
 * **Example:** Remove a file and its directory
 * ```typescript
 * yield* docs.delete("tmp/upload.bin");
 * yield* docs.deleteDirectory("tmp");
 * ```
 *
 * @binding
 * @category Storage
 */
export interface FileShareWrite extends Binding.Service<
  FileShareWrite,
  "Azure.Storage.FileShareWrite",
  (share: FileShare) => Effect.Effect<WriteFileShareClient>
> {}

export const FileShareWrite = Binding.Service<FileShareWrite>("Azure.Storage.FileShareWrite");
