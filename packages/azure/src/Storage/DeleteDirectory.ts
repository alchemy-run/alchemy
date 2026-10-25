import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `DeleteDirectory` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type DeleteDirectoryRequest = FileShareRequest<files.DeleteDirectoryRequest>;

/**
 * Delete an empty directory from an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `DeleteDirectory`).
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
 * Provide {@link DeleteDirectoryHttp}.
 *
 * ### Deleting Directories
 * **Example:** Delete an empty directory
 * ```typescript
 * // init
 * const deleteDirectory = yield* Azure.Storage.DeleteDirectory(share);
 *
 * // runtime
 * yield* deleteDirectory({ directory: "tmp" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteDirectory extends Binding.Service<
  DeleteDirectory,
  "Azure.Storage.DeleteDirectory",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: DeleteDirectoryRequest,
    ) => Effect.Effect<files.DeleteDirectoryResponse, files.DeleteDirectoryError, RuntimeContext>
  >
> {}

export const DeleteDirectory = Binding.Service<DeleteDirectory>("Azure.Storage.DeleteDirectory");
