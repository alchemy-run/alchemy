import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `ListKnowledgeBases` request without `endpoint`, which the bound bookshelf
 * (its `bookshelfUri`) supplies.
 */
export interface ListKnowledgeBasesRequest extends Omit<
  discovery.ListKnowledgeBasesRequest,
  "endpoint"
> {}

/**
 * List the bookshelf's knowledge bases. One page per call: pass `nextLink` for
 * the next.
 *
 * Binding assigns the built-in **Microsoft Discovery Bookshelf Index Data
 * Reader** role (data actions `bookshelf/knowledgebases/read`,
 * `bookshelf/knowledgebases/operations/read` and
 * `bookshelf/knowledgeBaseVersions/query/action`) on the bound bookshelf only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListKnowledgeBasesHttp}.
 *
 * ### Calling ListKnowledgeBases
 * **Example:** ListKnowledgeBases from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const listKnowledgeBases = yield* Azure.Discovery.ListKnowledgeBases(bookshelf);
 *
 * // runtime
 * const result = yield* listKnowledgeBases();
 *
 * // layer
 * Effect.provide(Azure.Discovery.ListKnowledgeBasesHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface ListKnowledgeBases extends Binding.Service<
  ListKnowledgeBases,
  "Azure.Discovery.ListKnowledgeBases",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request?: ListKnowledgeBasesRequest,
    ) => Effect.Effect<
      discovery.PagedKnowledgeBase,
      discovery.ListKnowledgeBasesError,
      RuntimeContext
    >
  >
> {}

export const ListKnowledgeBases = Binding.Service<ListKnowledgeBases>(
  "Azure.Discovery.ListKnowledgeBases",
);
