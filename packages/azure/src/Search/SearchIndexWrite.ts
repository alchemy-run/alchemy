import type { AzureOpError } from "@distilled.cloud/azure";
import type * as searchData from "@distilled.cloud/azure/search-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SearchIndex } from "./SearchIndex.ts";

/** A document: field name to value. It must carry the index's key field. */
export type SearchIndexDocument = Record<string, unknown>;

/** Write client for one Azure AI Search index. */
export interface WriteSearchIndexClient {
  /** Insert documents, replacing any with the same key. */
  upload(
    documents: readonly SearchIndexDocument[],
  ): Effect.Effect<searchData.IndexingResult[], AzureOpError, RuntimeContext>;
  /** Update fields of existing documents; a missing key fails that document (404). */
  merge(
    documents: readonly SearchIndexDocument[],
  ): Effect.Effect<searchData.IndexingResult[], AzureOpError, RuntimeContext>;
  /** Merge into existing documents, or upload the ones that do not exist. */
  mergeOrUpload(
    documents: readonly SearchIndexDocument[],
  ): Effect.Effect<searchData.IndexingResult[], AzureOpError, RuntimeContext>;
  /** Delete documents by key (only the key field is read). */
  delete(
    documents: readonly SearchIndexDocument[],
  ): Effect.Effect<searchData.IndexingResult[], AzureOpError, RuntimeContext>;
}

/**
 * Load documents into an Azure AI Search index from any host: upload,
 * merge, merge-or-upload, and delete. Each call is one indexing batch and
 * returns one `IndexingResult` per document (`status: false` with a
 * `statusCode` when that document failed).
 *
 * Binding assigns a custom role (`AzureSearchIndexDocumentsRole`, one per
 * stack) with exactly the data actions `indexes/documents/write` and
 * `indexes/documents/delete`, on the index only. The smallest built-in
 * role, **Search Index Data Contributor**, also grants reads. The search
 * service must accept Microsoft Entra ID tokens
 * (`authMode: "aadOrApiKey"`). Managed-identity hosts get the role on
 * their identity; any other host gets an Entra service principal (see
 * `AzureBindings`). Provide {@link SearchIndexWriteHttp}.
 *
 * ### Loading Documents
 * **Example:** Upload and delete from a Function
 * ```typescript
 * // init
 * const hotels = yield* Azure.Search.SearchIndexWrite(index);
 *
 * // runtime
 * yield* hotels.upload([{ id: "1", name: "Seaside Inn", rating: 4 }]);
 * yield* hotels.merge([{ id: "1", rating: 5 }]);
 * yield* hotels.delete([{ id: "1" }]);
 * ```
 *
 * @binding
 * @category Search
 */
export interface SearchIndexWrite extends Binding.Service<
  SearchIndexWrite,
  "Azure.Search.SearchIndexWrite",
  (index: SearchIndex) => Effect.Effect<WriteSearchIndexClient>
> {}

export const SearchIndexWrite = Binding.Service<SearchIndexWrite>("Azure.Search.SearchIndexWrite");
