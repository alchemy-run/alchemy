import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `GetKnowledgeBase` request without `endpoint`, which the bound bookshelf (its
 * `bookshelfUri`) supplies.
 */
export interface GetKnowledgeBaseRequest extends Omit<
  discovery.GetKnowledgeBaseRequest,
  "endpoint"
> {}

/**
 * Read a knowledge base.
 *
 * Binding assigns the built-in **Microsoft Discovery Bookshelf Index Data
 * Reader** role (data actions `bookshelf/knowledgebases/read`,
 * `bookshelf/knowledgebases/operations/read` and
 * `bookshelf/knowledgeBaseVersions/query/action`) on the bound bookshelf only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetKnowledgeBaseHttp}.
 *
 * ### Calling GetKnowledgeBase
 * **Example:** GetKnowledgeBase from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const getKnowledgeBase = yield* Azure.Discovery.GetKnowledgeBase(bookshelf);
 *
 * // runtime
 * const result = yield* getKnowledgeBase({ knowledgeBaseName: "papers" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetKnowledgeBaseHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetKnowledgeBase extends Binding.Service<
  GetKnowledgeBase,
  "Azure.Discovery.GetKnowledgeBase",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request: GetKnowledgeBaseRequest,
    ) => Effect.Effect<discovery.KnowledgeBase, discovery.GetKnowledgeBaseError, RuntimeContext>
  >
> {}

export const GetKnowledgeBase = Binding.Service<GetKnowledgeBase>(
  "Azure.Discovery.GetKnowledgeBase",
);
