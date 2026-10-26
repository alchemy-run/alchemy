import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `CopyFileAbort` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type AbortCopyFileRequest = FileShareRequest<files.CopyFileAbortRequest>;

/**
 * Abort a pending copy into a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `CopyFileAbort`).
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
 * Provide {@link AbortCopyFileHttp}.
 *
 * ### Aborting Copies
 * **Example:** Abort a copy started with StartCopyFile
 * ```typescript
 * // init
 * const abortCopyFile = yield* Azure.Storage.AbortCopyFile(share);
 *
 * // runtime
 * const copy = yield* startCopyFile({ fileName: "backup/disk.vhd", xMsCopySource: sourceUrl });
 * yield* abortCopyFile({ fileName: "backup/disk.vhd", copyid: copy.xMsCopyId! });
 * // …provided with Effect.provide(Azure.Storage.AbortCopyFileHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface AbortCopyFile extends Binding.Service<
  AbortCopyFile,
  "Azure.Storage.AbortCopyFile",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: AbortCopyFileRequest,
    ) => Effect.Effect<files.CopyFileAbortResponse, files.CopyFileAbortError, RuntimeContext>
  >
> {}

export const AbortCopyFile = Binding.Service<AbortCopyFile>("Azure.Storage.AbortCopyFile");
