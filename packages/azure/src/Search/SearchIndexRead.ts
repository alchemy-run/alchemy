import type { AzureOpError } from "@distilled.cloud/azure";
import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";

/** A search query, without the endpoint and index the binding supplies. */
export interface SearchDocumentsRequest extends Omit<
  searchData.DocumentsSearchPostRequest,
  "endpoint" | "indexName"
> {}

/** A suggest query, without the endpoint and index the binding supplies. */
export interface SuggestDocumentsRequest extends Omit<
  searchData.PostDocumentsSuggestRequest,
  "endpoint" | "indexName"
> {}

/** An autocomplete query, without the endpoint and index the binding supplies. */
export interface AutocompleteDocumentsRequest extends Omit<
  searchData.PostDocumentsAutocompleteRequest,
  "endpoint" | "indexName"
> {}

/** Read client for one Azure AI Search index. */
export interface ReadSearchIndexClient {
  /** Run a full-text, filter, or vector query. */
  search(
    request?: SearchDocumentsRequest,
  ): Effect.Effect<searchData.SearchDocumentsResult, AzureOpError, RuntimeContext>;
  /**
   * Look up one document by key, optionally only the `select` fields,
   * without its `@odata.*` annotations. `undefined` when no document has
   * that key.
   */
  get(
    key: string,
    select?: string[],
  ): Effect.Effect<searchData.LookupDocument | undefined, AzureOpError, RuntimeContext>;
  /** Number of documents in the index. */
  count(): Effect.Effect<number, AzureOpError, RuntimeContext>;
  /** Suggest documents whose suggester fields match partial text. */
  suggest(
    request: SuggestDocumentsRequest,
  ): Effect.Effect<searchData.SuggestDocumentsResult, AzureOpError, RuntimeContext>;
  /** Complete partial query terms from a suggester's fields. */
  autocomplete(
    request: AutocompleteDocumentsRequest,
  ): Effect.Effect<searchData.AutocompleteResult, AzureOpError, RuntimeContext>;
}

/**
 * Query an Azure AI Search index from any host: search, look up by key,
 * count, suggest, and autocomplete.
 *
 * Binding assigns **Search Index Data Reader** (exactly the data action
 * `indexes/documents/read`) on the index only. The search service must
 * accept Microsoft Entra ID tokens (`authMode: "aadOrApiKey"`). On a host
 * with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity. On any other host (a Cloudflare Worker, an AWS
 * Lambda) Alchemy creates an Entra service principal for the host, assigns
 * the role to it, and binds its client secret into the host's env (see
 * `AzureBindings`). Provide {@link SearchIndexReadHttp}.
 *
 * ### Querying an Index
 * **Example:** Search from a Function
 * ```typescript
 * // init
 * const hotels = yield* Azure.Search.SearchIndexRead(index);
 *
 * // runtime
 * const results = yield* hotels.search({ search: "beach", filter: "rating ge 4", top: 10 });
 * const names = results.value.map((hit) => hit.name);
 * ```
 *
 * **Example:** Look up, count, and suggest
 * ```typescript
 * const hotel = yield* hotels.get("1", ["id", "name"]);
 * const total = yield* hotels.count();
 * const suggestions = yield* hotels.suggest({ search: "sea", suggesterName: "names" });
 * ```
 *
 * @binding
 * @category Search
 */
export interface SearchIndexRead extends Binding.Service<
  SearchIndexRead,
  "Azure.Search.SearchIndexRead",
  (index: SearchIndex) => Effect.Effect<ReadSearchIndexClient>
> {}

export const SearchIndexRead = Binding.Service<SearchIndexRead>("Azure.Search.SearchIndexRead");
