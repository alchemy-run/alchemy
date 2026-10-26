import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `FileStartCopy` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type StartCopyFileRequest = FileShareRequest<files.FileStartCopyRequest>;

/**
 * Start a server-side copy of a file or blob into a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `FileStartCopy`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) and the `AzureStorageFileShareWriter`
 * custom role (`fileshares/files/write` + `writeFileBackupSemantics/action`,
 * created once per stack) on the share only: Azure Files reads a source file
 * in the same account with the caller's own token, so a copy needs both. A
 * source in another account must carry its own SAS in `xMsCopySource`. The
 * built-in Privileged Contributor would also grant delete and ACL changes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link StartCopyFileHttp}.
 *
 * ### Copying Files
 * **Example:** Copy a file within the share
 * ```typescript
 * // init
 * const startCopyFile = yield* Azure.Storage.StartCopyFile(share);
 *
 * // runtime
 * const copy = yield* startCopyFile({
 *   fileName: "archive/report.csv",
 *   xMsCopySource: "https://myaccount.file.core.windows.net/myshare/reports/report.csv",
 * });
 * // copy.xMsCopyStatus: "success" | "pending"
 * // …provided with Effect.provide(Azure.Storage.StartCopyFileHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface StartCopyFile extends Binding.Service<
  StartCopyFile,
  "Azure.Storage.StartCopyFile",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: StartCopyFileRequest,
    ) => Effect.Effect<files.FileStartCopyResponse, files.FileStartCopyError, RuntimeContext>
  >
> {}

export const StartCopyFile = Binding.Service<StartCopyFile>("Azure.Storage.StartCopyFile");
