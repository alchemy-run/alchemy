import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `SetShareProperties` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type SetSharePropertiesRequest = FileShareRequest<files.SetSharePropertiesRequest>;

/**
 * Set the properties of an Azure Files share (quota, access tier, root squash), over the File REST API with Microsoft Entra tokens
 * (`storage-file` `SetShareProperties`).
 *
 * Binding assigns the `AzureStorageFileSharePropertiesWriter` custom role
 * (`fileServices/shares/write`, created once per stack) on the share only;
 * the built-in roles that hold it (Contributor, Storage Account Contributor)
 * also grant deletes and every other storage resource. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link SetSharePropertiesHttp}.
 *
 * ### Setting Share Properties
 * **Example:** Grow a share's quota
 * ```typescript
 * // init
 * const setShareProperties = yield* Azure.Storage.SetShareProperties(share);
 *
 * // runtime
 * yield* setShareProperties({ xMsShareQuota: 200 });
 * // …provided with Effect.provide(Azure.Storage.SetSharePropertiesHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetShareProperties extends Binding.Service<
  SetShareProperties,
  "Azure.Storage.SetShareProperties",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: SetSharePropertiesRequest,
    ) => Effect.Effect<files.SetSharePropertiesResponse, files.SetSharePropertiesError, RuntimeContext>
  >
> {}

export const SetShareProperties = Binding.Service<SetShareProperties>("Azure.Storage.SetShareProperties");
