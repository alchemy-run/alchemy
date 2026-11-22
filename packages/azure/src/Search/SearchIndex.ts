import * as search from "@distilled.cloud/azure/search";
import * as searchData from "@distilled.cloud/azure/search-data";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createSearchName, getSearchService, searchServiceOwnedByStage } from "./internal.ts";

export type SearchIndexField = searchData.SearchField;
export type SearchIndexSuggester = searchData.SearchSuggester;
export type SearchIndexScoringProfile = searchData.ScoringProfile;
export type SearchIndexCorsOptions = searchData.CorsOptions;
export type SearchIndexSemanticSearch = searchData.SemanticSearch;
export type SearchIndexVectorSearch = searchData.VectorSearch;

export interface SearchIndexProps {
  /**
   * Resource group of the search service.
   *
   * :::caution
   * Changing it replaces the index and deletes its documents.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the `Azure.Search.SearchService` that holds the index. The
   * service must accept Microsoft Entra ID tokens (`authMode: "aadOrApiKey"`,
   * or `disableLocalAuth: true`).
   *
   * :::caution
   * Changing it replaces the index and deletes its documents.
   * :::
   */
  searchService: string;
  /**
   * Index name: lowercase letters, digits, and dashes, at most 128
   * characters.
   *
   * :::caution
   * Changing it replaces the index and deletes its documents.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Description of the index.
   * @default none
   */
  description?: string;
  /**
   * Fields of the index. Exactly one top-level `Edm.String` field must have
   * `key: true`. New fields are added in place.
   *
   * :::caution
   * Removing a field, or changing anything on an existing field other than
   * `retrievable`, `searchAnalyzer`, or `synonymMaps`, replaces the index and
   * deletes its documents.
   * :::
   */
  fields: SearchIndexField[];
  /**
   * Suggesters for `suggest` and `autocomplete` queries. Adding one
   * happens in place.
   *
   * :::caution
   * Removing or changing an existing suggester replaces the index and
   * deletes its documents.
   * :::
   * @default []
   */
  suggesters?: SearchIndexSuggester[];
  /**
   * Scoring profiles that boost results by field values, freshness, or
   * distance. Changes happen in place.
   * @default []
   */
  scoringProfiles?: SearchIndexScoringProfile[];
  /**
   * Scoring profile used when a query names none.
   * @default none (plain relevance)
   */
  defaultScoringProfile?: string;
  /**
   * Cross-origin resource sharing for browser queries.
   * @default no CORS
   */
  corsOptions?: SearchIndexCorsOptions;
  /**
   * Semantic ranker configurations. The service needs `semanticSearch`
   * enabled.
   * @default none
   */
  semantic?: SearchIndexSemanticSearch;
  /**
   * Vector search algorithms, profiles, and vectorizers. A vector field
   * names its profile in `vectorSearchProfile`.
   * @default none
   */
  vectorSearch?: SearchIndexVectorSearch;
}

export interface SearchIndex extends Resource<
  "Azure.Search.SearchIndex",
  SearchIndexProps,
  {
    /** Name of the index. */
    indexName: string;
    /**
     * ARM-style ID of the index
     * (`{searchServiceId}/indexes/{indexName}`); role assignments on it
     * grant access to this index only.
     */
    indexId: string;
    /** Name of the search service that holds the index. */
    searchService: string;
    /** Resource group of the search service. */
    resourceGroup: string;
    /** Data-plane endpoint of the search service, e.g. `https://{name}.search.windows.net`. */
    endpoint: string;
    /** Name of the key field. */
    keyField: string | undefined;
    /** Names of the top-level fields. */
    fieldNames: string[];
  },
  never,
  Providers
> {}

/**
 * An index in an Azure AI Search service: the schema (fields, suggesters,
 * scoring profiles, semantic and vector configuration) that documents are
 * loaded into and queried against.
 *
 * Alchemy manages the index through the search data plane with Microsoft
 * Entra ID, so the service must use `authMode: "aadOrApiKey"` (or
 * `disableLocalAuth: true`). New fields, scoring profiles, CORS, semantic,
 * and vector settings update the index in place and keep its documents.
 * Runtimes query and load it through `Azure.Search.SearchIndexRead`,
 * `SearchIndexWrite`, `SearchIndexReadWrite`, or one binding per operation
 * (`SearchDocuments`, `IndexDocuments`, …).
 *
 * :::caution[Removing a field or changing an existing one replaces the index]
 * Alchemy deletes the index with its documents and creates it again with
 * the new schema. Changing `name`, `searchService`, or `resourceGroup`, or
 * removing or changing a suggester, replaces it too. Only `retrievable`,
 * `searchAnalyzer`, and `synonymMaps` change in place on an existing field.
 * :::
 *
 * See [Search indexes in Azure AI Search](https://learn.microsoft.com/azure/search/search-what-is-an-index).
 *
 * ### Creating an Index
 * **Example:** Hotels index with a suggester
 * ```typescript
 * const service = yield* Azure.Search.SearchService("Search", {
 *   sku: "basic",
 *   authMode: "aadOrApiKey",
 * });
 * const fields: Azure.Search.SearchIndexField[] = [
 *   { name: "id", type: "Edm.String", key: true },
 *   { name: "name", type: "Edm.String", searchable: true },
 *   { name: "description", type: "Edm.String", searchable: true },
 *   { name: "city", type: "Edm.String", filterable: true, facetable: true },
 *   { name: "rating", type: "Edm.Int32", filterable: true, sortable: true },
 * ];
 * const hotels = yield* Azure.Search.SearchIndex("Hotels", {
 *   searchService: service.searchServiceName,
 *   fields,
 *   suggesters: [{ name: "names", searchMode: "analyzingInfixMatching", sourceFields: ["name"] }],
 * });
 * ```
 *
 * ### Evolving the Schema
 * **Example:** Add a field in place
 * ```diff
 * const hotels = yield* Azure.Search.SearchIndex("Hotels", {
 *   searchService: service.searchServiceName,
 *   fields: [
 *     { name: "id", type: "Edm.String", key: true },
 *     { name: "name", type: "Edm.String", searchable: true },
 *     { name: "rating", type: "Edm.Int32", filterable: true, sortable: true },
 * +    { name: "tags", type: "Collection(Edm.String)", filterable: true, facetable: true },
 *   ],
 * });
 * ```
 *
 * ### Relevance
 * **Example:** Boost matches in the name
 * ```typescript
 * const hotels = yield* Azure.Search.SearchIndex("Hotels", {
 *   searchService: service.searchServiceName,
 *   fields,
 *   scoringProfiles: [{ name: "byName", text: { weights: { name: 3 } } }],
 *   defaultScoringProfile: "byName",
 * });
 * ```
 *
 * **Example:** Semantic ranking configuration
 * ```typescript
 * // The service needs semanticSearch: "free" or "standard".
 * const hotels = yield* Azure.Search.SearchIndex("Hotels", {
 *   searchService: service.searchServiceName,
 *   fields,
 *   semantic: {
 *     defaultConfiguration: "default",
 *     configurations: [
 *       {
 *         name: "default",
 *         prioritizedFields: {
 *           titleField: { fieldName: "name" },
 *           prioritizedContentFields: [{ fieldName: "description" }],
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Vector Search
 * **Example:** Index with a 1536-dimension embedding field
 * ```typescript
 * const docs = yield* Azure.Search.SearchIndex("Docs", {
 *   searchService: service.searchServiceName,
 *   fields: [
 *     { name: "id", type: "Edm.String", key: true },
 *     { name: "content", type: "Edm.String", searchable: true },
 *     {
 *       name: "embedding",
 *       type: "Collection(Edm.Single)",
 *       searchable: true,
 *       dimensions: 1536,
 *       vectorSearchProfile: "default",
 *     },
 *   ],
 *   vectorSearch: {
 *     algorithms: [{ name: "hnsw", kind: "hnsw" }],
 *     profiles: [{ name: "default", algorithm: "hnsw" }],
 *   },
 * });
 * ```
 *
 * ### Browser Queries
 * **Example:** Allow CORS from your site
 * ```typescript
 * const hotels = yield* Azure.Search.SearchIndex("Hotels", {
 *   searchService: service.searchServiceName,
 *   fields,
 *   corsOptions: { allowedOrigins: ["https://app.example.com"], maxAgeInSeconds: 300 },
 * });
 * ```
 *
 * ### Binding to a runtime
 * `SearchIndexRead` assigns **Search Index Data Reader** on this index
 * only. `SearchIndexWrite` assigns a custom role with exactly
 * `indexes/documents/write` and `indexes/documents/delete` on this index
 * only. `SearchIndexReadWrite` assigns both. The roles go to the host's
 * managed identity (an Azure Function, Web App, Container App, container
 * group, or VM) or, on any other host, to an Entra service principal.
 *
 * **Example:** Query and load the index from an Azure Function
 * ```typescript
 * // src/Api.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Hotels } from "./resources.ts";
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const hotels = yield* Hotels;
 *     const index = yield* Azure.Search.SearchIndexReadWrite(hotels);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* index.mergeOrUpload([{ id: "1", name: "Seaside Inn", rating: 4 }]);
 *         const results = yield* index.search({ search: "seaside", top: 10 });
 *         return yield* HttpServerResponse.json(results.value);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Search.SearchIndexReadWriteHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Search, look up, count, and suggest
 * ```typescript
 * // init
 * const hotels = yield* Azure.Search.SearchIndexRead(index);
 *
 * // runtime
 * const results = yield* hotels.search({ search: "beach", filter: "rating ge 4", top: 10 });
 * const hotel = yield* hotels.get("1", ["id", "name"]); // undefined when missing
 * const total = yield* hotels.count();
 * const suggestions = yield* hotels.suggest({ search: "sea", suggesterName: "names" });
 * const completions = yield* hotels.autocomplete({ search: "sea", suggesterName: "names" });
 * // …provided with Effect.provide(Azure.Search.SearchIndexReadHttp)
 * ```
 *
 * **Example:** Upload, merge, and delete documents
 * ```typescript
 * // init
 * const hotels = yield* Azure.Search.SearchIndexWrite(index);
 *
 * // runtime: one indexing batch per call, one result per document
 * const results = yield* hotels.upload([{ id: "1", name: "Seaside Inn", rating: 4 }]);
 * const failed = results.filter((result) => !result.status);
 * yield* hotels.merge([{ id: "1", rating: 5 }]);
 * yield* hotels.delete([{ id: "1" }]);
 * // …provided with Effect.provide(Azure.Search.SearchIndexWriteHttp)
 * ```
 *
 * **Example:** One operation per binding
 * ```typescript
 * // init
 * const searchHotels = yield* Azure.Search.SearchDocuments(index);
 * const statistics = yield* Azure.Search.GetIndexStatistics(index);
 *
 * // runtime
 * const page = yield* searchHotels({ search: "beach", count: true });
 * const total = page._odata_count;
 * const stats = yield* statistics();
 * // …provided with Effect.provide([Azure.Search.SearchDocumentsHttp, Azure.Search.GetIndexStatisticsHttp])
 * ```
 *
 * ### Deleting an Index
 * Destroying the index deletes it and its documents. Deleting the search
 * service deletes every index in it.
 *
 * @resource
 */
export const SearchIndex = GroupedResource<SearchIndex>("Azure.Search.SearchIndex");

/** Field properties Azure lets an existing field change in place. */
const MUTABLE_FIELD_KEYS = new Set(["retrievable", "searchAnalyzer", "synonymMaps"]);

const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * Whether every value `desired` sets is present in `observed` (Azure fills
 * in defaults for the rest). Arrays must match element by element.
 */
const covers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, i) => covers(item, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      covers(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};

/** An existing field changed in a way Azure only allows by rebuilding the index. */
const fieldRebuilt = (old: SearchIndexField, next: SearchIndexField | undefined): boolean => {
  if (next === undefined) return true;
  const olds = new Map<string, unknown>(Object.entries(old));
  const news = new Map<string, unknown>(Object.entries(next));
  for (const key of new Set([...olds.keys(), ...news.keys()])) {
    if (MUTABLE_FIELD_KEYS.has(key)) continue;
    const a = olds.get(key);
    const b = news.get(key);
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) return true;
  }
  return false;
};

const schemaRebuilt = (olds: SearchIndexProps, news: SearchIndexProps) => {
  const next = new Map(news.fields.map((f) => [f.name, f]));
  if (olds.fields.some((f) => fieldRebuilt(f, next.get(f.name)))) return true;
  const nextSuggesters = new Map((news.suggesters ?? []).map((s) => [s.name, s]));
  return (olds.suggesters ?? []).some(
    (s) => JSON.stringify(s) !== JSON.stringify(nextSuggesters.get(s.name) ?? null),
  );
};

/** The index definition Alchemy sends and compares. */
const definitionOf = (news: SearchIndexProps) => ({
  description: news.description,
  fields: news.fields,
  suggesters: news.suggesters,
  scoringProfiles: news.scoringProfiles,
  defaultScoringProfile: news.defaultScoringProfile,
  corsOptions: news.corsOptions,
  semantic: news.semantic,
  vectorSearch: news.vectorSearch,
});

const indexIdOf = (
  subscriptionId: string,
  resourceGroup: string,
  searchService: string,
  indexName: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Search/searchServices/${searchService}/indexes/${indexName}`;

const endpointOf = (service: search.GetServiceResponse, searchService: string) =>
  (service.properties?.endpoint ?? `https://${searchService}.search.windows.net`).replace(
    /\/+$/,
    "",
  );

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  searchService: string,
  endpoint: string,
  index: searchData.SearchIndex,
): SearchIndex["Attributes"] => ({
  indexName: index.name,
  indexId: indexIdOf(subscriptionId, resourceGroup, searchService, index.name),
  searchService,
  resourceGroup,
  endpoint,
  keyField: index.fields.find((f) => f.key === true)?.name,
  fieldNames: index.fields.map((f) => f.name),
});

const getIndex = (endpoint: string, indexName: string) =>
  orUndefinedIfNotFound(searchData.GetIndex({ endpoint, indexName }));

export const SearchIndexProvider = () =>
  Provider.succeed(SearchIndex, {
    stables: ["indexName", "indexId", "searchService", "resourceGroup", "endpoint"],

    // Indexes live inside a search service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.searchService) !== lower(output.searchService) ||
        (news.name !== undefined && news.name !== output.indexName) ||
        (olds !== undefined && schemaRebuilt(olds, news))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const searchService = output?.searchService ?? olds?.searchService;
      if (resourceGroup === undefined || searchService === undefined) return undefined;
      const service = yield* getSearchService(subscriptionId, resourceGroup, searchService);
      if (service === undefined) return undefined;
      const endpoint = endpointOf(service, searchService);
      const name = output?.indexName ?? olds?.name ?? (yield* createSearchName(id, 128));
      const observed = yield* getIndex(endpoint, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, resourceGroup, searchService, endpoint, observed);
      return (yield* searchServiceOwnedByStage(subscriptionId, resourceGroup, searchService))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const { resourceGroup, searchService } = news;
      const name = news.name ?? output?.indexName ?? (yield* createSearchName(id, 128));
      const service = yield* search.GetService({
        subscriptionId,
        resourceGroupName: resourceGroup,
        searchServiceName: searchService,
      });
      const endpoint = endpointOf(service, searchService);
      const desired = definitionOf(news);

      // Observe.
      const observed = yield* getIndex(endpoint, name);

      // Ensure + sync: the PUT upserts the whole definition, so send it when
      // the index is missing or any value we set drifted.
      if (observed === undefined || !covers(desired, observed)) {
        const updated = yield* searchData.IndexesCreateOrUpdate({
          endpoint,
          indexName: name,
          name,
          ...desired,
        });
        return toAttrs(subscriptionId, resourceGroup, searchService, endpoint, updated);
      }
      return toAttrs(subscriptionId, resourceGroup, searchService, endpoint, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A deleted service took its indexes (and its DNS name) with it.
      const service = yield* getSearchService(
        subscriptionId,
        output.resourceGroup,
        output.searchService,
      );
      if (service === undefined) return;
      yield* orUndefinedIfNotFound(
        searchData.DeleteIndex({ endpoint: output.endpoint, indexName: output.indexName }),
      );
    }),
  });
