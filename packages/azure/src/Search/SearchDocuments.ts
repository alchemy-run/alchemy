import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";
import type { SearchDocumentsRequest } from "./SearchIndexRead.ts";

/**
 * Run a full-text, filter, or vector query against an Azure AI Search
 * index from any host (`POST /docs/search.post.search`).
 *
 * Binding assigns **Search Index Data Reader** (exactly the data action
 * `indexes/documents/read`) on the index only. The search service must accept Microsoft Entra ID
 * tokens (`authMode: "aadOrApiKey"`). On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container
 * group, VM, or AKS workload identity) the role goes to that identity; any
 * other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal (see `AzureBindings`). Provide {@link SearchDocumentsHttp}.
 *
 * ### Calling SearchDocuments
 * **Example:** Filtered search from a Function
 * ```typescript
 * // init
 * const searchHotels = yield* Azure.Search.SearchDocuments(index);
 *
 * // runtime
 * const results = yield* searchHotels({ search: "beach", filter: "rating ge 4", count: true });
 * const total = results._odata_count;
 * ```
 *
 * @binding
 * @category Search
 */
export interface SearchDocuments extends Binding.Service<
  SearchDocuments,
  "Azure.Search.SearchDocuments",
  (
    index: SearchIndex,
  ) => Effect.Effect<
    (
      request?: SearchDocumentsRequest,
    ) => Effect.Effect<
      searchData.SearchDocumentsResult,
      searchData.DocumentsSearchPostError,
      RuntimeContext
    >
  >
> {}

export const SearchDocuments = Binding.Service<SearchDocuments>("Azure.Search.SearchDocuments");
