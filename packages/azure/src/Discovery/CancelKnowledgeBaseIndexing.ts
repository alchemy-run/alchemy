import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `CancelKnowledgeBaseIndexing` request without `endpoint`, which the bound
 * bookshelf (its `bookshelfUri`) supplies.
 */
export interface CancelKnowledgeBaseIndexingRequest extends Omit<
  discovery.CancelKnowledgeBaseIndexingRequest,
  "endpoint"
> {}

/**
 * Cancel a knowledge base's indexing.
 *
 * Binding assigns a custom role (`AzureDiscoveryKnowledgeBaseWriteRole`, one
 * per stack) with the data actions
 * `Microsoft.Discovery/bookshelf/knowledgebases/*`, on the bound bookshelf
 * only: the provider publishes no narrower write or indexing data action, and
 * the built-in **Microsoft Discovery Platform Contributor** grants
 * `Microsoft.Discovery/*`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelKnowledgeBaseIndexingHttp}.
 *
 * ### Calling CancelKnowledgeBaseIndexing
 * **Example:** CancelKnowledgeBaseIndexing from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const cancelKnowledgeBaseIndexing = yield* Azure.Discovery.CancelKnowledgeBaseIndexing(bookshelf);
 *
 * // runtime
 * const result = yield* cancelKnowledgeBaseIndexing({ knowledgeBaseName: "papers" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.CancelKnowledgeBaseIndexingHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface CancelKnowledgeBaseIndexing extends Binding.Service<
  CancelKnowledgeBaseIndexing,
  "Azure.Discovery.CancelKnowledgeBaseIndexing",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request: CancelKnowledgeBaseIndexingRequest,
    ) => Effect.Effect<
      discovery.CancelKnowledgeBaseIndexingResponse,
      discovery.CancelKnowledgeBaseIndexingError,
      RuntimeContext
    >
  >
> {}

export const CancelKnowledgeBaseIndexing = Binding.Service<CancelKnowledgeBaseIndexing>(
  "Azure.Discovery.CancelKnowledgeBaseIndexing",
);
