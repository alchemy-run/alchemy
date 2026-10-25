import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";
import type { ReadSearchIndexClient } from "./SearchIndexRead.ts";
import type { WriteSearchIndexClient } from "./SearchIndexWrite.ts";

/** Read + write client for one Azure AI Search index. */
export interface ReadWriteSearchIndexClient extends ReadSearchIndexClient, WriteSearchIndexClient {}

/**
 * Query and load an Azure AI Search index from any host.
 *
 * Binding assigns **Search Index Data Reader** (`indexes/documents/read`)
 * and the custom `AzureSearchIndexDocumentsRole`
 * (`indexes/documents/write` + `indexes/documents/delete`) on the index
 * only; together they are exactly the data actions the client calls. The
 * search service must accept Microsoft Entra ID tokens
 * (`authMode: "aadOrApiKey"`). Managed-identity hosts get the roles on
 * their identity; any other host gets an Entra service principal (see
 * `AzureBindings`). Provide {@link SearchIndexReadWriteHttp}.
 *
 * ### Querying and Loading an Index
 * **Example:** Upload a document and find it
 * ```typescript
 * // init
 * const hotels = yield* Azure.Search.SearchIndexReadWrite(index);
 *
 * // runtime
 * yield* hotels.mergeOrUpload([{ id: "1", name: "Seaside Inn" }]);
 * const hotel = yield* hotels.get("1");
 * const hits = yield* hotels.search({ search: "seaside" });
 * ```
 *
 * @binding
 * @category Search
 */
export interface SearchIndexReadWrite extends Binding.Service<
  SearchIndexReadWrite,
  "Azure.Search.SearchIndexReadWrite",
  (index: SearchIndex) => Effect.Effect<ReadWriteSearchIndexClient>
> {}

export const SearchIndexReadWrite = Binding.Service<SearchIndexReadWrite>(
  "Azure.Search.SearchIndexReadWrite",
);
