import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";
import type { SuggestDocumentsRequest } from "./SearchIndexRead.ts";

/**
 * Suggest documents whose suggester fields match partial text in an
 * Azure AI Search index, from any host. The index needs a suggester.
 *
 * Binding assigns **Search Index Data Reader** (exactly the data action
 * `indexes/documents/read`) on the index only. The search service must accept Microsoft Entra ID
 * tokens (`authMode: "aadOrApiKey"`). On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container
 * group, VM, or AKS workload identity) the role goes to that identity; any
 * other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal (see `AzureBindings`). Provide {@link SuggestDocumentsHttp}.
 *
 * ### Calling SuggestDocuments
 * **Example:** Type-ahead suggestions
 * ```typescript
 * // init
 * const suggest = yield* Azure.Search.SuggestDocuments(index);
 *
 * // runtime
 * const { value } = yield* suggest({ search: "sea", suggesterName: "names", top: 5 });
 * const texts = value.map((s) => s._search_text);
 * ```
 *
 * @binding
 * @category Search
 */
export interface SuggestDocuments extends Binding.Service<
  SuggestDocuments,
  "Azure.Search.SuggestDocuments",
  (
    index: SearchIndex,
  ) => Effect.Effect<
    (
      request: SuggestDocumentsRequest,
    ) => Effect.Effect<
      searchData.SuggestDocumentsResult,
      searchData.PostDocumentsSuggestError,
      RuntimeContext
    >
  >
> {}

export const SuggestDocuments = Binding.Service<SuggestDocuments>("Azure.Search.SuggestDocuments");
