import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `SearchKnowledgeBase` request without `endpoint`, which the bound bookshelf
 * (its `bookshelfUri`) supplies.
 */
export interface SearchKnowledgeBaseRequest extends Omit<
  discovery.SearchKnowledgeBaseRequest,
  "endpoint"
> {}

/**
 * Search a knowledge base.
 *
 * Binding assigns the built-in **Microsoft Discovery Bookshelf Index Data
 * Reader** role (data actions `bookshelf/knowledgebases/read`,
 * `bookshelf/knowledgebases/operations/read` and
 * `bookshelf/knowledgeBaseVersions/query/action`) on the bound bookshelf only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SearchKnowledgeBaseHttp}.
 *
 * ### Calling SearchKnowledgeBase
 * **Example:** SearchKnowledgeBase from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const searchKnowledgeBase = yield* Azure.Discovery.SearchKnowledgeBase(bookshelf);
 *
 * // runtime
 * const result = yield* searchKnowledgeBase({ knowledgeBaseName: "papers", query: "battery electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.SearchKnowledgeBaseHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface SearchKnowledgeBase extends Binding.Service<
  SearchKnowledgeBase,
  "Azure.Discovery.SearchKnowledgeBase",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request: SearchKnowledgeBaseRequest,
    ) => Effect.Effect<
      discovery.SearchKnowledgeBaseResponse,
      discovery.SearchKnowledgeBaseError,
      RuntimeContext
    >
  >
> {}

export const SearchKnowledgeBase = Binding.Service<SearchKnowledgeBase>(
  "Azure.Discovery.SearchKnowledgeBase",
);
