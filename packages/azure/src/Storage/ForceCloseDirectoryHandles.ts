import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `DirectoryForceCloseHandles` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ForceCloseDirectoryHandlesRequest = FileShareRequest<files.DirectoryForceCloseHandlesRequest>;

/**
 * Force-close open SMB handles on a directory (and, recursively, its files) in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `DirectoryForceCloseHandles`).
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
 * Provide {@link ForceCloseDirectoryHandlesHttp}.
 *
 * ### Closing Handles
 * **Example:** Close every handle under a directory
 * ```typescript
 * // init
 * const forceCloseDirectoryHandles = yield* Azure.Storage.ForceCloseDirectoryHandles(share);
 *
 * // runtime
 * yield* forceCloseDirectoryHandles({ directory: "reports", xMsHandleId: "*", xMsRecursive: true });
 * // …provided with Effect.provide(Azure.Storage.ForceCloseDirectoryHandlesHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ForceCloseDirectoryHandles extends Binding.Service<
  ForceCloseDirectoryHandles,
  "Azure.Storage.ForceCloseDirectoryHandles",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ForceCloseDirectoryHandlesRequest,
    ) => Effect.Effect<files.DirectoryForceCloseHandlesResponse, files.DirectoryForceCloseHandlesError, RuntimeContext>
  >
> {}

export const ForceCloseDirectoryHandles = Binding.Service<ForceCloseDirectoryHandles>("Azure.Storage.ForceCloseDirectoryHandles");
