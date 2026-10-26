import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `SetDirectoryProperties` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type SetDirectoryPropertiesRequest = FileShareRequest<files.SetDirectoryPropertiesRequest>;

/**
 * Set the SMB attributes and timestamps of a directory in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `SetDirectoryProperties`).
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
 * Provide {@link SetDirectoryPropertiesHttp}.
 *
 * ### Setting Directory Properties
 * **Example:** Mark a directory hidden
 * ```typescript
 * // init
 * const setDirectoryProperties = yield* Azure.Storage.SetDirectoryProperties(share);
 *
 * // runtime
 * // a directory's attribute list must name `Directory`
 * yield* setDirectoryProperties({ directory: "cache", xMsFileAttributes: "Directory|Hidden" });
 * // …provided with Effect.provide(Azure.Storage.SetDirectoryPropertiesHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetDirectoryProperties extends Binding.Service<
  SetDirectoryProperties,
  "Azure.Storage.SetDirectoryProperties",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: SetDirectoryPropertiesRequest,
    ) => Effect.Effect<files.SetDirectoryPropertiesResponse, files.SetDirectoryPropertiesError, RuntimeContext>
  >
> {}

export const SetDirectoryProperties = Binding.Service<SetDirectoryProperties>("Azure.Storage.SetDirectoryProperties");
