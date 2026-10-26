import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `RenameDirectory` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type RenameDirectoryRequest = FileShareRequest<files.RenameDirectoryRequest>;

/**
 * Rename or move a directory within an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `RenameDirectory`).
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
 * Provide {@link RenameDirectoryHttp}.
 *
 * ### Renaming Directories
 * **Example:** Rename a directory
 * ```typescript
 * // init
 * const renameDirectory = yield* Azure.Storage.RenameDirectory(share);
 *
 * // runtime
 * yield* renameDirectory({
 *   directory: "reports-2025",
 *   // the full URL of the source in the same share
 *   xMsFileRenameSource: "https://myaccount.file.core.windows.net/myshare/reports",
 * });
 * // …provided with Effect.provide(Azure.Storage.RenameDirectoryHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface RenameDirectory extends Binding.Service<
  RenameDirectory,
  "Azure.Storage.RenameDirectory",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: RenameDirectoryRequest,
    ) => Effect.Effect<files.RenameDirectoryResponse, files.RenameDirectoryError, RuntimeContext>
  >
> {}

export const RenameDirectory = Binding.Service<RenameDirectory>("Azure.Storage.RenameDirectory");
