import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `DownloadFile` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type DownloadFileRequest = FileShareRequest<files.DownloadFileRequest>;

/**
 * Download a file (or a byte range of it) from an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `DownloadFile`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link DownloadFileHttp}.
 *
 * ### Reading Files
 * **Example:** Read a file as text
 * ```typescript
 * // init
 * const downloadFile = yield* Azure.Storage.DownloadFile(share);
 *
 * // runtime
 * const file = yield* downloadFile({ fileName: "reports/q1.csv" });
 * const csv = new TextDecoder().decode(file.body);
 * ```
 *
 * **Example:** Read the first kilobyte
 * ```typescript
 * const head = yield* downloadFile({ fileName: "logs/app.log", xMsRange: "bytes=0-1023" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DownloadFile extends Binding.Service<
  DownloadFile,
  "Azure.Storage.DownloadFile",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: DownloadFileRequest,
    ) => Effect.Effect<files.DownloadFileResponse, files.DownloadFileError, RuntimeContext>
  >
> {}

export const DownloadFile = Binding.Service<DownloadFile>("Azure.Storage.DownloadFile");
