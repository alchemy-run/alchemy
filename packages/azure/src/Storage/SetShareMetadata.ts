import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `SetShareMetadata` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type SetShareMetadataRequest = FileShareRequest<files.SetShareMetadataRequest>;

/**
 * Replace the user metadata of an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `SetShareMetadata`).
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
 * Provide {@link SetShareMetadataHttp}.
 *
 * ### Setting Share Metadata
 * **Example:** Tag a share with metadata
 * ```typescript
 * // init
 * const setShareMetadata = yield* Azure.Storage.SetShareMetadata(share);
 *
 * // runtime
 * yield* setShareMetadata({ metadata: { owner: "finance" } });
 * // …provided with Effect.provide(Azure.Storage.SetShareMetadataHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetShareMetadata extends Binding.Service<
  SetShareMetadata,
  "Azure.Storage.SetShareMetadata",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: SetShareMetadataRequest,
    ) => Effect.Effect<files.SetShareMetadataResponse, files.SetShareMetadataError, RuntimeContext>
  >
> {}

export const SetShareMetadata = Binding.Service<SetShareMetadata>("Azure.Storage.SetShareMetadata");
