import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `GetShareStatistics` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetShareStatisticsRequest = FileShareRequest<files.GetShareStatisticsRequest>;

/**
 * Read the approximate bytes stored in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `GetShareStatistics`).
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
 * Provide {@link GetShareStatisticsHttp}.
 *
 * ### Reading Share Statistics
 * **Example:** Read a share's usage
 * ```typescript
 * // init
 * const getShareStatistics = yield* Azure.Storage.GetShareStatistics(share);
 *
 * // runtime
 * const { ShareUsageBytes } = yield* getShareStatistics();
 * // …provided with Effect.provide(Azure.Storage.GetShareStatisticsHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetShareStatistics extends Binding.Service<
  GetShareStatistics,
  "Azure.Storage.GetShareStatistics",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: GetShareStatisticsRequest,
    ) => Effect.Effect<files.GetShareStatisticsResponse, files.GetShareStatisticsError, RuntimeContext>
  >
> {}

export const GetShareStatistics = Binding.Service<GetShareStatistics>("Azure.Storage.GetShareStatistics");
