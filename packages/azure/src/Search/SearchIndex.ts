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
  /** Resource group of the search service. Changing it replaces the index. */
  resourceGroup: string;
  /**
   * Name of the search service that holds the index. The service must accept
   * Microsoft Entra ID tokens (`authMode: "aadOrApiKey"`, or
   * `disableLocalAuth: true`). Changing it replaces the index.
   */
  searchService: string;
  /**
   * Index name: lowercase letters, digits, and dashes, at most 128
   * characters. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the index.
   */
  name?: string;
  /** Description of the index. */
  description?: string;
  /**
   * Fields of the index. Exactly one top-level `Edm.String` field must have
   * `key: true`. New fields are added in place; removing a field or
   * changing anything on an existing field other than `retrievable`,
   * `searchAnalyzer`, or `synonymMaps` replaces the index (its documents
   * are lost).
   */
  fields: SearchIndexField[];
  /**
   * Suggesters for `suggest` and `autocomplete` queries. Removing or
   * changing an existing suggester replaces the index.
   */
  suggesters?: SearchIndexSuggester[];
  /** Scoring profiles. */
  scoringProfiles?: SearchIndexScoringProfile[];
  /** Scoring profile used when a query names none. */
  defaultScoringProfile?: string;
  /** Cross-origin resource sharing for browser queries. */
  corsOptions?: SearchIndexCorsOptions;
  /** Semantic ranker configurations. */
  semantic?: SearchIndexSemanticSearch;
  /** Vector search algorithms, profiles, and vectorizers. */
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
 * loaded into and queried against. Alchemy manages the index through the
 * search data plane with Microsoft Entra ID, so the service must use
 * `authMode: "aadOrApiKey"` (or `disableLocalAuth: true`). Bind it to a
 * Function or Worker with `Azure.Search.SearchIndexRead`,
 * `SearchIndexWrite`, or one binding per operation (`SearchDocuments`,
 * `IndexDocuments`, …).
 *
 * @see https://learn.microsoft.com/azure/search/search-what-is-an-index
 *
 * ### Creating an Index
 * **Example:** Hotels index with a suggester
 * ```typescript
 * const service = yield* Azure.Search.SearchService("search", {
 *   authMode: "aadOrApiKey",
 * });
 * const hotels = yield* Azure.Search.SearchIndex("hotels", {
 *   searchService: service.searchServiceName,
 *   fields: [
 *     { name: "id", type: "Edm.String", key: true },
 *     { name: "name", type: "Edm.String", searchable: true },
 *     { name: "rating", type: "Edm.Int32", filterable: true, sortable: true },
 *   ],
 *   suggesters: [{ name: "names", searchMode: "analyzingInfixMatching", sourceFields: ["name"] }],
 * });
 * ```
 *
 * ### Evolving the Schema
 * **Example:** Add a field in place
 * ```typescript
 * const hotels = yield* Azure.Search.SearchIndex("hotels", {
 *   searchService: service.searchServiceName,
 *   fields: [
 *     { name: "id", type: "Edm.String", key: true },
 *     { name: "name", type: "Edm.String", searchable: true },
 *     { name: "rating", type: "Edm.Int32", filterable: true, sortable: true },
 *     { name: "city", type: "Edm.String", filterable: true, facetable: true },
 *   ],
 * });
 * ```
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
