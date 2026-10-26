import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `GetFileSymbolicLink` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetFileSymbolicLinkRequest = FileShareRequest<files.GetFileSymbolicLinkRequest>;

/**
 * Read the target of a symbolic link in an NFS Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `GetFileSymbolicLink`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link GetFileSymbolicLinkHttp}.
 *
 * ### Reading Symbolic Links
 * **Example:** Resolve a link
 * ```typescript
 * // init
 * const getFileSymbolicLink = yield* Azure.Storage.GetFileSymbolicLink(share);
 *
 * // runtime
 * const { xMsLinkText } = yield* getFileSymbolicLink({ fileName: "latest" });
 * // Azure Files answers the target percent-encoded: "releases%2Fv2"
 * const target = decodeURIComponent(xMsLinkText ?? "");
 * // …provided with Effect.provide(Azure.Storage.GetFileSymbolicLinkHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetFileSymbolicLink extends Binding.Service<
  GetFileSymbolicLink,
  "Azure.Storage.GetFileSymbolicLink",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: GetFileSymbolicLinkRequest,
    ) => Effect.Effect<files.GetFileSymbolicLinkResponse, files.GetFileSymbolicLinkError, RuntimeContext>
  >
> {}

export const GetFileSymbolicLink = Binding.Service<GetFileSymbolicLink>("Azure.Storage.GetFileSymbolicLink");
