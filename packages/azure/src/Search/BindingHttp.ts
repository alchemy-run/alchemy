import * as searchData from "@distilled.cloud/azure/search-data";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { SearchIndex } from "./SearchIndex.ts";
import type {
  AutocompleteDocumentsRequest,
  ReadSearchIndexClient,
  SearchDocumentsRequest,
  SuggestDocumentsRequest,
} from "./SearchIndexRead.ts";
import type { SearchIndexDocument, WriteSearchIndexClient } from "./SearchIndexWrite.ts";

/**
 * Shared scaffolding for the Azure AI Search index bindings: resolves the
 * distilled `search-data` operation once when the layer is built, injects
 * the bound index's endpoint and name, and assigns the binding's roles on
 * that index (never the service) at deploy time.
 *
 * NOT exported from `index.ts`.
 */

const INDEXES = "Microsoft.Search/searchServices/indexes";

/** Azure AI Search operations the index bindings grant. */
export const SearchAction = {
  /** Data action: query, look up, count, suggest, and autocomplete documents. */
  readDocuments: `${INDEXES}/documents/read`,
  /** Data action: upload, merge, and merge-or-upload documents. */
  writeDocuments: `${INDEXES}/documents/write`,
  /** Data action: delete documents. */
  deleteDocuments: `${INDEXES}/documents/delete`,
  /** Control action: read the index definition and its statistics. */
  readIndex: `${INDEXES}/read`,
} as const;

/** Built-in **Search Index Data Reader**: exactly `indexes/documents/read`. */
export const SEARCH_INDEX_DATA_READER = "1407120a-92aa-4202-b7e9-c0e197c71c8f";

/**
 * A role an index binding assigns: a built-in role GUID, or a custom role
 * (`Azure.Authorization.RoleDefinition`, defined once per stack at the
 * subscription and assigned only on the bound index) with exactly
 * `actions` / `dataActions`.
 */
export type SearchGrant =
  | { readonly builtIn: string }
  | {
      readonly role: string;
      readonly actions?: readonly string[];
      readonly dataActions?: readonly string[];
    };

/** Grants per binding kind; a custom role's logical ID is `AzureSearch<role>Role`. */
export const SearchRole = {
  ReadDocuments: { builtIn: SEARCH_INDEX_DATA_READER },
  /** Search Index Data Contributor also grants reads and elevated reads. */
  WriteDocuments: {
    role: "IndexDocuments",
    dataActions: [SearchAction.writeDocuments, SearchAction.deleteDocuments],
  },
  /** The smallest built-in role with `indexes/read` is Search Service Contributor. */
  ReadIndexStatistics: { role: "IndexStatistics", actions: [SearchAction.readIndex] },
} as const satisfies Record<string, SearchGrant>;

/** Assign `grants` on the index to the host, creating the custom roles they name. */
const GrantSearchRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, index: SearchIndex, grants: readonly SearchGrant[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        if ("builtIn" in grant) {
          roleAssignments.push({ roleDefinitionId: grant.builtIn, scope: index.indexId });
          continue;
        }
        const role = yield* AzureRoleDefinition(`AzureSearch${grant.role}Role`, {
          description: `Alchemy Search binding: ${[
            ...(grant.actions ?? []),
            ...(grant.dataActions ?? []),
          ].join(", ")}`,
          permissions: [
            {
              actions: grant.actions === undefined ? undefined : [...grant.actions],
              dataActions: grant.dataActions === undefined ? undefined : [...grant.dataActions],
            },
          ],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope: index.indexId });
      }
      yield* bind`${tag}(${index})`({ roleAssignments });
    }
  });
});

/** Where an index lives, resolved per call at runtime. */
export interface SearchIndexAddress {
  readonly tag: string;
  readonly at: Effect.Effect<{ endpoint: string; indexName: string }>;
}

const addressOf = Effect.fn(function* (tag: string, index: SearchIndex) {
  const endpoint = yield* index.endpoint;
  const indexName = yield* index.indexName;
  return {
    tag: `${tag}(${index.LogicalId})`,
    at: Effect.all({ endpoint, indexName }),
  } satisfies SearchIndexAddress;
});

/**
 * Build the impl Effect for an index-scoped operation whose request carries
 * `endpoint` + `indexName` (`SearchDocuments`, `GetDocument`,
 * `IndexDocuments`, …): the runtime callable injects the bound
 * {@link SearchIndex}'s endpoint and name, and the deploy-time half assigns
 * `grants` on the index.
 */
export const makeSearchIndexHttpBinding = <
  I extends { endpoint: string; indexName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Search.SearchDocuments`. */
  tag: string;
  /** The distilled operation; the endpoint and index name are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the index. */
  grants: readonly SearchGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantSearchRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (index: SearchIndex) {
      yield* grant(options.tag, index, options.grants);
      const address = yield* addressOf(options.tag, index);
      return Effect.fn(address.tag)(function* (request?: Omit<I, "endpoint" | "indexName">) {
        const where = yield* address.at;
        return yield* op({ ...request, ...where } as I);
      });
    });
  });

/** A looked-up document without its `@odata.*` annotations (field names cannot start with `@`). */
const withoutAnnotations = (document: searchData.LookupDocument): searchData.LookupDocument =>
  Object.fromEntries(Object.entries(document).filter(([name]) => !name.startsWith("@")));

export const makeReadSearchIndexClient = Effect.gen(function* () {
  const searchPost = yield* AzureBindings.withCredentials(searchData.DocumentsSearchPost);
  const getDocument = yield* AzureBindings.withCredentials(searchData.GetDocument);
  const count = yield* AzureBindings.withCredentials(searchData.DocumentsCount);
  const suggest = yield* AzureBindings.withCredentials(searchData.PostDocumentsSuggest);
  const autocomplete = yield* AzureBindings.withCredentials(searchData.PostDocumentsAutocomplete);
  return (address: SearchIndexAddress): ReadSearchIndexClient => ({
    search: Effect.fn(`${address.tag}.search`)(function* (request?: SearchDocumentsRequest) {
      const where = yield* address.at;
      return yield* searchPost({ ...request, ...where });
    }),
    get: Effect.fn(`${address.tag}.get`)(function* (key: string, select?: string[]) {
      const where = yield* address.at;
      return yield* getDocument({ ...where, key, _select: select?.join(",") }).pipe(
        Effect.map(withoutAnnotations),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    count: Effect.fn(`${address.tag}.count`)(function* () {
      const where = yield* address.at;
      return yield* count(where);
    }),
    suggest: Effect.fn(`${address.tag}.suggest`)(function* (request: SuggestDocumentsRequest) {
      const where = yield* address.at;
      return yield* suggest({ ...request, ...where });
    }),
    autocomplete: Effect.fn(`${address.tag}.autocomplete`)(function* (
      request: AutocompleteDocumentsRequest,
    ) {
      const where = yield* address.at;
      return yield* autocomplete({ ...request, ...where });
    }),
  });
});

export const makeWriteSearchIndexClient = Effect.gen(function* () {
  const indexDocuments = yield* AzureBindings.withCredentials(searchData.ListDocuments);
  return (address: SearchIndexAddress): WriteSearchIndexClient => {
    const send = (action: searchData.IndexActionType, label: string) =>
      Effect.fn(`${address.tag}.${label}`)(function* (documents: readonly SearchIndexDocument[]) {
        const where = yield* address.at;
        const result = yield* indexDocuments({
          ...where,
          value: documents.map((document) => ({ ...document, _search_action: action })),
        });
        return result.value;
      });
    return {
      upload: send("upload", "upload"),
      merge: send("merge", "merge"),
      mergeOrUpload: send("mergeOrUpload", "mergeOrUpload"),
      delete: send("delete", "delete"),
    };
  };
});

/**
 * Build a Read/Write/ReadWrite index binding that assigns `grants` on the
 * index and returns the client `makeClient` builds.
 */
export const makeSearchIndexLevelBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Search.SearchIndexRead`. */
  tag: string;
  /** Roles assigned on the index. */
  grants: readonly SearchGrant[];
  makeClient: Effect.Effect<(address: SearchIndexAddress) => Client>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantSearchRoles;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (index: SearchIndex) {
      yield* grant(options.tag, index, options.grants);
      const address = yield* addressOf(options.tag, index);
      return makeClient(address);
    });
  });
