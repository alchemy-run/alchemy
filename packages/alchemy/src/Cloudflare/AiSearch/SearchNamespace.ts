import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Namespace } from "./Namespace.ts";
import type { SearchClient, SearchError } from "./Search.ts";

/**
 * Bind an {@link Namespace} to a Worker and obtain the Effect-native
 * namespace client whose `.get(name)` selects an instance at runtime. The
 * `ai_search_namespace` binding resolves to a runtime `Namespace`
 * whose `.get(name)` selects an instance within the namespace at runtime.
 *
 * `SearchNamespace` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.AiSearch.SearchNamespace(namespace)`.
 *
 * Provide {@link SearchNamespaceBinding} in the Worker's runtime layer.
 *
 * @binding
 * @category AI
 *
 * @section Querying a namespace
 * @example Select an instance at runtime
 * ```typescript
 * const ns = yield* Cloudflare.AiSearch.SearchNamespace(namespace);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const answer = yield* ns.get("docs-search").chatCompletions({
 *       messages: [{ role: "user", content: query }],
 *     });
 *     return yield* HttpServerResponse.json(answer);
 *   }),
 * };
 * ```
 */
export interface SearchNamespace extends Binding.Service<
  SearchNamespace,
  "Cloudflare.AiSearch.SearchNamespace",
  (namespace: Namespace) => Effect.Effect<SearchNamespaceClient>
> {}

export const SearchNamespace = Binding.Service<SearchNamespace>(
  "Cloudflare.AiSearch.SearchNamespace",
);

/**
 * Effect-native client for an `ai_search_namespace` binding, wrapping the
 * runtime `Namespace`. `.get(name)` selects an instance within the
 * bound namespace and returns its {@link SearchClient}; `list` / `search`
 * operate across the namespace.
 */
export interface SearchNamespaceClient {
  /**
   * Effect resolving to the raw underlying Cloudflare `Namespace`
   * binding. Use this for operations not surfaced below (`create`, `delete`,
   * multi-instance `chatCompletions`).
   */
  raw: Effect.Effect<runtime.AiSearchNamespace, never, RuntimeContext>;
  /**
   * Select an instance within the bound namespace by name.
   */
  get(instanceName: string): SearchClient;
  /**
   * List the instances within the bound namespace.
   */
  list(
    params?: runtime.AiSearchListInstancesParams,
  ): Effect.Effect<runtime.AiSearchListResponse, SearchError, RuntimeContext>;
  /**
   * Search across multiple instances in the bound namespace (requires
   * `ai_search_options.instance_ids`).
   */
  search(
    params: runtime.AiSearchMultiSearchRequest,
  ): Effect.Effect<
    runtime.AiSearchMultiSearchResponse,
    SearchError,
    RuntimeContext
  >;
}
