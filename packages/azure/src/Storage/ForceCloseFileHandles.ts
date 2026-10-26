import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `FileForceCloseHandles` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ForceCloseFileHandlesRequest = FileShareRequest<files.FileForceCloseHandlesRequest>;

/**
 * Force-close open SMB handles on a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `FileForceCloseHandles`).
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
 * Provide {@link ForceCloseFileHandlesHttp}.
 *
 * ### Closing Handles
 * **Example:** Close every handle on a file
 * ```typescript
 * // init
 * const forceCloseFileHandles = yield* Azure.Storage.ForceCloseFileHandles(share);
 *
 * // runtime
 * const { xMsNumberOfHandlesClosed } = yield* forceCloseFileHandles({
 *   fileName: "reports/q1.xlsx",
 *   xMsHandleId: "*",
 * });
 * // …provided with Effect.provide(Azure.Storage.ForceCloseFileHandlesHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ForceCloseFileHandles extends Binding.Service<
  ForceCloseFileHandles,
  "Azure.Storage.ForceCloseFileHandles",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ForceCloseFileHandlesRequest,
    ) => Effect.Effect<files.FileForceCloseHandlesResponse, files.FileForceCloseHandlesError, RuntimeContext>
  >
> {}

export const ForceCloseFileHandles = Binding.Service<ForceCloseFileHandles>("Azure.Storage.ForceCloseFileHandles");
