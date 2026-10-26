import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `CreateFileHardLink` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type CreateFileHardLinkRequest = FileShareRequest<files.CreateFileHardLinkRequest>;

/**
 * Create a hard link to an existing file in an NFS Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `CreateFileHardLink`).
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
 * Provide {@link CreateFileHardLinkHttp}.
 *
 * ### Creating Hard Links
 * **Example:** Link a second name to a file
 * ```typescript
 * // init
 * const createFileHardLink = yield* Azure.Storage.CreateFileHardLink(share);
 *
 * // runtime
 * yield* createFileHardLink({ fileName: "current/data.bin", xMsFileTargetFile: "v2/data.bin" });
 * // …provided with Effect.provide(Azure.Storage.CreateFileHardLinkHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateFileHardLink extends Binding.Service<
  CreateFileHardLink,
  "Azure.Storage.CreateFileHardLink",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: CreateFileHardLinkRequest,
    ) => Effect.Effect<files.CreateFileHardLinkResponse, files.CreateFileHardLinkError, RuntimeContext>
  >
> {}

export const CreateFileHardLink = Binding.Service<CreateFileHardLink>("Azure.Storage.CreateFileHardLink");
