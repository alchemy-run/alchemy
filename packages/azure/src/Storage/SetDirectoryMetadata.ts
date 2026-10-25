import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `SetDirectoryMetadata` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type SetDirectoryMetadataRequest = FileShareRequest<files.SetDirectoryMetadataRequest>;

/**
 * Replace the user metadata of a directory in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `SetDirectoryMetadata`).
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
 * Provide {@link SetDirectoryMetadataHttp}.
 *
 * ### Setting Directory Metadata
 * **Example:** Tag a directory with metadata
 * ```typescript
 * // init
 * const setDirectoryMetadata = yield* Azure.Storage.SetDirectoryMetadata(share);
 *
 * // runtime
 * yield* setDirectoryMetadata({ directory: "reports", metadata: { team: "finance" } });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetDirectoryMetadata extends Binding.Service<
  SetDirectoryMetadata,
  "Azure.Storage.SetDirectoryMetadata",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: SetDirectoryMetadataRequest,
    ) => Effect.Effect<
      files.SetDirectoryMetadataResponse,
      files.SetDirectoryMetadataError,
      RuntimeContext
    >
  >
> {}

export const SetDirectoryMetadata = Binding.Service<SetDirectoryMetadata>(
  "Azure.Storage.SetDirectoryMetadata",
);
