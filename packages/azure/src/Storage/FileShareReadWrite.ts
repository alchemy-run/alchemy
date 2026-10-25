import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { ReadFileShareClient } from "./FileShareRead.ts";
import type { WriteFileShareClient } from "./FileShareWrite.ts";

/** Read + write client for one file share. */
export interface ReadWriteFileShareClient extends ReadFileShareClient, WriteFileShareClient {}

/**
 * Read and write access to an Azure Files share from any host, over the
 * File REST API with Microsoft Entra tokens.
 *
 * Binding assigns, on the share only, **Storage File Data Privileged
 * Reader** plus the `AzureStorageFileShareWriter` and
 * `AzureStorageFileShareDeleter` custom roles described on
 * {@link FileShareWrite}; it never grants ACL changes
 * (`modifypermissions`). See `AzureBindings` for how the roles reach a
 * managed-identity host or any other host.
 * Provide {@link FileShareReadWriteHttp}.
 *
 * ### Reading and Writing Files
 * **Example:** Copy a file
 * ```typescript
 * // init
 * const docs = yield* Azure.Storage.FileShareReadWrite(share);
 *
 * // runtime
 * const file = yield* docs.get("in/data.csv");
 * if (file) yield* docs.put("out/data.csv", file.body);
 * ```
 *
 * @binding
 * @category Storage
 */
export interface FileShareReadWrite extends Binding.Service<
  FileShareReadWrite,
  "Azure.Storage.FileShareReadWrite",
  (share: FileShare) => Effect.Effect<ReadWriteFileShareClient>
> {}

export const FileShareReadWrite = Binding.Service<FileShareReadWrite>(
  "Azure.Storage.FileShareReadWrite",
);
