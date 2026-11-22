import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";

export interface IndexDocumentsRequest extends Omit<
  searchData.ListDocumentsRequest,
  "endpoint" | "indexName"
> {}

/**
 * Send one batch of document actions (`upload`, `merge`, `mergeOrUpload`,
 * `delete`) to an Azure AI Search index from any host. The result has one
 * `IndexingResult` per document; a failed document has `status: false`.
 * (distilled names this operation `ListDocuments`.)
 *
 * Binding assigns a custom role (`AzureSearchIndexDocumentsRole`, one per
 * stack) with exactly the data actions `indexes/documents/write` and
 * `indexes/documents/delete`, on the index only. The smallest built-in
 * role, **Search Index Data Contributor**, also grants reads. The search service must accept Microsoft Entra ID
 * tokens (`authMode: "aadOrApiKey"`). On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container
 * group, VM, or AKS workload identity) the role goes to that identity; any
 * other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal (see `AzureBindings`). Provide {@link IndexDocumentsHttp}.
 *
 * ### Calling IndexDocuments
 * **Example:** Upload and delete in one batch
 * ```typescript
 * // init
 * const indexHotels = yield* Azure.Search.IndexDocuments(index);
 *
 * // runtime
 * const { value } = yield* indexHotels({
 *   value: [
 *     { _search_action: "upload", id: "1", name: "Seaside Inn" },
 *     { _search_action: "delete", id: "2" },
 *   ],
 * });
 * ```
 *
 * @binding
 * @category Search
 */
export interface IndexDocuments extends Binding.Service<
  IndexDocuments,
  "Azure.Search.IndexDocuments",
  (
    index: SearchIndex,
  ) => Effect.Effect<
    (
      request: IndexDocumentsRequest,
    ) => Effect.Effect<
      searchData.IndexDocumentsResult,
      searchData.ListDocumentsError,
      RuntimeContext
    >
  >
> {}

export const IndexDocuments = Binding.Service<IndexDocuments>("Azure.Search.IndexDocuments");
