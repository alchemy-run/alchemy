import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";

export interface GetIndexStatisticsRequest extends Omit<
  searchData.GetIndexStatisticsRequest,
  "endpoint" | "indexName"
> {}

/**
 * Read an Azure AI Search index's document count, storage size, and vector
 * index size from any host. The figures trail writes by a few seconds.
 *
 * Binding assigns a custom role (`AzureSearchIndexStatisticsRole`, one per
 * stack) with exactly the action `Microsoft.Search/searchServices/indexes/read`,
 * on the index only. The smallest built-in role with it, **Search Service
 * Contributor**, manages the whole service. The search service must accept Microsoft Entra ID
 * tokens (`authMode: "aadOrApiKey"`). On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container
 * group, VM, or AKS workload identity) the role goes to that identity; any
 * other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal (see `AzureBindings`). Provide {@link GetIndexStatisticsHttp}.
 *
 * ### Calling GetIndexStatistics
 * **Example:** Read index statistics
 * ```typescript
 * // init
 * const stats = yield* Azure.Search.GetIndexStatistics(index);
 *
 * // runtime
 * const { documentCount, storageSize } = yield* stats();
 * ```
 *
 * @binding
 * @category Search
 */
export interface GetIndexStatistics extends Binding.Service<
  GetIndexStatistics,
  "Azure.Search.GetIndexStatistics",
  (
    index: SearchIndex,
  ) => Effect.Effect<
    (
      request?: GetIndexStatisticsRequest,
    ) => Effect.Effect<
      searchData.GetIndexStatisticsResult,
      searchData.GetIndexStatisticsError,
      RuntimeContext
    >
  >
> {}

export const GetIndexStatistics = Binding.Service<GetIndexStatistics>(
  "Azure.Search.GetIndexStatistics",
);
