import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `UploadFileRange` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type UploadFileRangeRequest = FileShareRequest<files.UploadFileRangeRequest>;

/**
 * Write (or clear) a byte range of a file in an Azure Files share (at most 4 MiB per call), over the File REST API with Microsoft Entra tokens
 * (`storage-file` `UploadFileRange`).
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
 * Provide {@link UploadFileRangeHttp}.
 *
 * ### Writing File Content
 * **Example:** Write bytes at the start of a file
 * ```typescript
 * // init
 * const uploadFileRange = yield* Azure.Storage.UploadFileRange(share);
 *
 * // runtime
 * const body = new TextEncoder().encode("hello");
 * yield* uploadFileRange({
 *   fileName: "logs/today.log",
 *   xMsRange: "bytes=0-4",
 *   xMsWrite: "update",
 *   body,
 * });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UploadFileRange extends Binding.Service<
  UploadFileRange,
  "Azure.Storage.UploadFileRange",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: UploadFileRangeRequest,
    ) => Effect.Effect<files.UploadFileRangeResponse, files.UploadFileRangeError, RuntimeContext>
  >
> {}

export const UploadFileRange = Binding.Service<UploadFileRange>("Azure.Storage.UploadFileRange");
