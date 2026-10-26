import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `CreateSharePermission` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type CreateSharePermissionRequest = FileShareRequest<files.CreateSharePermissionRequest>;

/**
 * Store a security descriptor (SDDL) at the share level of an Azure Files share and get its permission key, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `CreateSharePermission`).
 *
 * Binding assigns the `AzureStorageFileSharePermissionWriter` custom role
 * (`fileshares/files/modifypermissions/action` +
 * `writeFileBackupSemantics/action`, created once per stack) on the share
 * only; the built-in Privileged Contributor would also grant read, write and
 * delete. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link CreateSharePermissionHttp}.
 *
 * ### Creating Permissions
 * **Example:** Store an SDDL and get its key
 * ```typescript
 * // init
 * const createSharePermission = yield* Azure.Storage.CreateSharePermission(share);
 *
 * // runtime
 * const { xMsFilePermissionKey } = yield* createSharePermission({
 *   sharePermission: { permission: "O:SYG:SYD:(A;;FA;;;SY)", format: "Sddl" },
 * });
 * // …provided with Effect.provide(Azure.Storage.CreateSharePermissionHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateSharePermission extends Binding.Service<
  CreateSharePermission,
  "Azure.Storage.CreateSharePermission",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: CreateSharePermissionRequest,
    ) => Effect.Effect<files.CreateSharePermissionResponse, files.CreateSharePermissionError, RuntimeContext>
  >
> {}

export const CreateSharePermission = Binding.Service<CreateSharePermission>("Azure.Storage.CreateSharePermission");
