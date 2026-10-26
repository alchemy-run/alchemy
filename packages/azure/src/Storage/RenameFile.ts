import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `RenameFile` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type RenameFileRequest = FileShareRequest<files.RenameFileRequest>;

/**
 * Rename or move a file within an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `RenameFile`).
 *
 * Binding assigns the `AzureStorageFileShareWriter` custom role
 * (`fileshares/files/write` + `writeFileBackupSemantics/action`, created
 * once per stack) on the share only; the built-in Privileged Contributor
 * would also grant read, delete and ACL changes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link RenameFileHttp}.
 *
 * ### Renaming Files
 * **Example:** Move a file into an archive directory
 * ```typescript
 * // init
 * const renameFile = yield* Azure.Storage.RenameFile(share);
 *
 * // runtime
 * yield* renameFile({
 *   fileName: "archive/q1.csv",
 *   // the full URL of the source in the same share
 *   xMsFileRenameSource: "https://myaccount.file.core.windows.net/myshare/reports/q1.csv",
 *   xMsFileRenameReplaceIfExists: true,
 * });
 * // …provided with Effect.provide(Azure.Storage.RenameFileHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface RenameFile extends Binding.Service<
  RenameFile,
  "Azure.Storage.RenameFile",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: RenameFileRequest,
    ) => Effect.Effect<files.RenameFileResponse, files.RenameFileError, RuntimeContext>
  >
> {}

export const RenameFile = Binding.Service<RenameFile>("Azure.Storage.RenameFile");
