import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `SetFileMetadata` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type SetFileMetadataRequest = FileShareRequest<files.SetFileMetadataRequest>;

/**
 * Replace the user metadata of a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `SetFileMetadata`).
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
 * Provide {@link SetFileMetadataHttp}.
 *
 * ### Setting File Metadata
 * **Example:** Tag a file with metadata
 * ```typescript
 * // init
 * const setFileMetadata = yield* Azure.Storage.SetFileMetadata(share);
 *
 * // runtime
 * yield* setFileMetadata({ fileName: "reports/q1.csv", metadata: { owner: "finance" } });
 * // …provided with Effect.provide(Azure.Storage.SetFileMetadataHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetFileMetadata extends Binding.Service<
  SetFileMetadata,
  "Azure.Storage.SetFileMetadata",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: SetFileMetadataRequest,
    ) => Effect.Effect<files.SetFileMetadataResponse, files.SetFileMetadataError, RuntimeContext>
  >
> {}

export const SetFileMetadata = Binding.Service<SetFileMetadata>("Azure.Storage.SetFileMetadata");
