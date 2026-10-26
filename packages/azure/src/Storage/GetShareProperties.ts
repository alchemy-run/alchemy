import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `GetShareProperties` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetSharePropertiesRequest = FileShareRequest<files.GetSharePropertiesRequest>;

/**
 * Read the properties and metadata of an Azure Files share (quota, tier, protocols, lease state), over the File REST API with Microsoft Entra tokens
 * (`storage-file` `GetShareProperties`).
 *
 * Binding assigns the `AzureStorageFileSharePropertiesReader` custom role
 * (`fileServices/shares/read`, created once per stack) on the share only;
 * no built-in data role covers share-level reads, and Reader would grant read
 * on every resource in its scope. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link GetSharePropertiesHttp}.
 *
 * ### Reading Share Properties
 * **Example:** Read a share's quota and metadata
 * ```typescript
 * // init
 * const getShareProperties = yield* Azure.Storage.GetShareProperties(share);
 *
 * // runtime
 * const { xMsShareQuota, metadata } = yield* getShareProperties();
 * // …provided with Effect.provide(Azure.Storage.GetSharePropertiesHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetShareProperties extends Binding.Service<
  GetShareProperties,
  "Azure.Storage.GetShareProperties",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: GetSharePropertiesRequest,
    ) => Effect.Effect<files.GetSharePropertiesResponse, files.GetSharePropertiesError, RuntimeContext>
  >
> {}

export const GetShareProperties = Binding.Service<GetShareProperties>("Azure.Storage.GetShareProperties");
