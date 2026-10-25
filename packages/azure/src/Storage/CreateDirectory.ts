import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `CreateDirectory` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type CreateDirectoryRequest = FileShareRequest<files.CreateDirectoryRequest>;

/**
 * Create a directory in an Azure Files share (its parent must exist), over the File REST API with Microsoft Entra tokens
 * (`storage-file` `CreateDirectory`).
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
 * Provide {@link CreateDirectoryHttp}.
 *
 * ### Creating Directories
 * **Example:** Create a directory
 * ```typescript
 * // init
 * const createDirectory = yield* Azure.Storage.CreateDirectory(share);
 *
 * // runtime
 * yield* createDirectory({ directory: "reports" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateDirectory extends Binding.Service<
  CreateDirectory,
  "Azure.Storage.CreateDirectory",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: CreateDirectoryRequest,
    ) => Effect.Effect<files.CreateDirectoryResponse, files.CreateDirectoryError, RuntimeContext>
  >
> {}

export const CreateDirectory = Binding.Service<CreateDirectory>("Azure.Storage.CreateDirectory");
