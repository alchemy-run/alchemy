import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `CreateFileSymbolicLink` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type CreateFileSymbolicLinkRequest = FileShareRequest<files.CreateFileSymbolicLinkRequest>;

/**
 * Create a symbolic link in an NFS Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `CreateFileSymbolicLink`).
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
 * Provide {@link CreateFileSymbolicLinkHttp}.
 *
 * ### Creating Symbolic Links
 * **Example:** Point a link at a file
 * ```typescript
 * // init
 * const createFileSymbolicLink = yield* Azure.Storage.CreateFileSymbolicLink(share);
 *
 * // runtime
 * yield* createFileSymbolicLink({ fileName: "latest", xMsLinkText: "releases/v2" });
 * // …provided with Effect.provide(Azure.Storage.CreateFileSymbolicLinkHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateFileSymbolicLink extends Binding.Service<
  CreateFileSymbolicLink,
  "Azure.Storage.CreateFileSymbolicLink",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: CreateFileSymbolicLinkRequest,
    ) => Effect.Effect<files.CreateFileSymbolicLinkResponse, files.CreateFileSymbolicLinkError, RuntimeContext>
  >
> {}

export const CreateFileSymbolicLink = Binding.Service<CreateFileSymbolicLink>("Azure.Storage.CreateFileSymbolicLink");
