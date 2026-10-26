import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `SetFileHTTPHeaders` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type SetFileHTTPHeadersRequest = FileShareRequest<files.SetFileHTTPHeadersRequest>;

/**
 * Set the HTTP headers (content type, cache control, ...) or the size of a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `SetFileHTTPHeaders`).
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
 * Provide {@link SetFileHTTPHeadersHttp}.
 *
 * ### Setting File Headers
 * **Example:** Set a file's content type
 * ```typescript
 * // init
 * const setFileHTTPHeaders = yield* Azure.Storage.SetFileHTTPHeaders(share);
 *
 * // runtime
 * yield* setFileHTTPHeaders({ fileName: "site/index.html", xMsContentType: "text/html" });
 * // …provided with Effect.provide(Azure.Storage.SetFileHTTPHeadersHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetFileHTTPHeaders extends Binding.Service<
  SetFileHTTPHeaders,
  "Azure.Storage.SetFileHTTPHeaders",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: SetFileHTTPHeadersRequest,
    ) => Effect.Effect<
      files.SetFileHTTPHeadersResponse,
      files.SetFileHTTPHeadersError,
      RuntimeContext
    >
  >
> {}

export const SetFileHTTPHeaders = Binding.Service<SetFileHTTPHeaders>(
  "Azure.Storage.SetFileHTTPHeaders",
);
