import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";
import type { AutocompleteDocumentsRequest } from "./SearchIndexRead.ts";

/**
 * Complete partial query terms from an Azure AI Search index's suggester
 * fields, from any host. The index needs a suggester.
 *
 * Binding assigns **Search Index Data Reader** (exactly the data action
 * `indexes/documents/read`) on the index only. The search service must accept Microsoft Entra ID
 * tokens (`authMode: "aadOrApiKey"`). On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container
 * group, VM, or AKS workload identity) the role goes to that identity; any
 * other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal (see `AzureBindings`). Provide {@link AutocompleteDocumentsHttp}.
 *
 * ### Calling AutocompleteDocuments
 * **Example:** Complete a query term
 * ```typescript
 * // init
 * const autocomplete = yield* Azure.Search.AutocompleteDocuments(index);
 *
 * // runtime
 * const { value } = yield* autocomplete({ search: "sea", suggesterName: "names" });
 * const terms = value.map((item) => item.text);
 * ```
 *
 * @binding
 * @category Search
 */
export interface AutocompleteDocuments extends Binding.Service<
  AutocompleteDocuments,
  "Azure.Search.AutocompleteDocuments",
  (
    index: SearchIndex,
  ) => Effect.Effect<
    (
      request: AutocompleteDocumentsRequest,
    ) => Effect.Effect<
      searchData.AutocompleteResult,
      searchData.PostDocumentsAutocompleteError,
      RuntimeContext
    >
  >
> {}

export const AutocompleteDocuments = Binding.Service<AutocompleteDocuments>(
  "Azure.Search.AutocompleteDocuments",
);
