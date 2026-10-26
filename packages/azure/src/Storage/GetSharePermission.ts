import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `GetSharePermission` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetSharePermissionRequest = FileShareRequest<files.GetSharePermissionRequest>;

/**
 * Read the security descriptor (SDDL) stored under a permission key in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `GetSharePermission`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link GetSharePermissionHttp}.
 *
 * ### Reading Permissions
 * **Example:** Resolve a permission key
 * ```typescript
 * // init
 * const getSharePermission = yield* Azure.Storage.GetSharePermission(share);
 *
 * // runtime
 * const { permission } = yield* getSharePermission({ xMsFilePermissionKey: key });
 * // …provided with Effect.provide(Azure.Storage.GetSharePermissionHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetSharePermission extends Binding.Service<
  GetSharePermission,
  "Azure.Storage.GetSharePermission",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: GetSharePermissionRequest,
    ) => Effect.Effect<files.GetSharePermissionResponse, files.GetSharePermissionError, RuntimeContext>
  >
> {}

export const GetSharePermission = Binding.Service<GetSharePermission>("Azure.Storage.GetSharePermission");
