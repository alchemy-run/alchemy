import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `UploadFileRangeFromURL` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type UploadFileRangeFromUrlRequest = FileShareRequest<files.UploadFileRangeFromURLRequest>;

/**
 * Write a byte range of a file in an Azure Files share from a source URL (a file or blob), server side, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `UploadFileRangeFromURL`).
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
 * Provide {@link UploadFileRangeFromUrlHttp}.
 *
 * ### Writing Ranges From a URL
 * **Example:** Copy the first 1 KiB of a blob into a file
 * ```typescript
 * // init
 * const uploadFileRangeFromUrl = yield* Azure.Storage.UploadFileRangeFromUrl(share);
 *
 * // runtime
 * yield* uploadFileRangeFromUrl({
 *   fileName: "disks/data.bin",
 *   xMsRange: "bytes=0-1023",
 *   xMsSourceRange: "bytes=0-1023",
 *   xMsCopySource: blobUrlWithSas,
 * });
 * // …provided with Effect.provide(Azure.Storage.UploadFileRangeFromUrlHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface UploadFileRangeFromUrl extends Binding.Service<
  UploadFileRangeFromUrl,
  "Azure.Storage.UploadFileRangeFromUrl",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: UploadFileRangeFromUrlRequest,
    ) => Effect.Effect<files.UploadFileRangeFromURLResponse, files.UploadFileRangeFromURLError, RuntimeContext>
  >
> {}

export const UploadFileRangeFromUrl = Binding.Service<UploadFileRangeFromUrl>("Azure.Storage.UploadFileRangeFromUrl");
