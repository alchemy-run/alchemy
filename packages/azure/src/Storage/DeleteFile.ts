import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `DeleteFile` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type DeleteFileRequest = FileShareRequest<files.DeleteFileRequest>;

/**
 * Delete a file from an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `DeleteFile`).
 *
 * Binding assigns the `AzureStorageFileShareDeleter` custom role
 * (`fileshares/files/delete` + `writeFileBackupSemantics/action`, created
 * once per stack) on the share only; the built-in Privileged Contributor
 * would also grant read, write and ACL changes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link DeleteFileHttp}.
 *
 * ### Deleting Files
 * **Example:** Delete a file
 * ```typescript
 * // init
 * const deleteFile = yield* Azure.Storage.DeleteFile(share);
 *
 * // runtime
 * yield* deleteFile({ fileName: "tmp/upload.bin" });
 * // …provided with Effect.provide(Azure.Storage.DeleteFileHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteFile extends Binding.Service<
  DeleteFile,
  "Azure.Storage.DeleteFile",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: DeleteFileRequest,
    ) => Effect.Effect<files.DeleteFileResponse, files.DeleteFileError, RuntimeContext>
  >
> {}

export const DeleteFile = Binding.Service<DeleteFile>("Azure.Storage.DeleteFile");
