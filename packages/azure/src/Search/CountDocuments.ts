import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";

export interface CountDocumentsRequest extends Omit<
  searchData.DocumentsCountRequest,
  "endpoint" | "indexName"
> {}

/**
 * Count the documents in an Azure AI Search index from any host.
 *
 * Binding assigns **Search Index Data Reader** (exactly the data action
 * `indexes/documents/read`) on the index only. The search service must accept Microsoft Entra ID
 * tokens (`authMode: "aadOrApiKey"`). On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container
 * group, VM, or AKS workload identity) the role goes to that identity; any
 * other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal (see `AzureBindings`). Provide {@link CountDocumentsHttp}.
 *
 * ### Calling CountDocuments
 * **Example:** Count documents
 * ```typescript
 * // init
 * const countHotels = yield* Azure.Search.CountDocuments(index);
 *
 * // runtime
 * const total = yield* countHotels();
 * ```
 *
 * @binding
 * @category Search
 */
export interface CountDocuments extends Binding.Service<
  CountDocuments,
  "Azure.Search.CountDocuments",
  (
    index: SearchIndex,
  ) => Effect.Effect<
    (
      request?: CountDocumentsRequest,
    ) => Effect.Effect<number, searchData.DocumentsCountError, RuntimeContext>
  >
> {}

export const CountDocuments = Binding.Service<CountDocuments>("Azure.Search.CountDocuments");
