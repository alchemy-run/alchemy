import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `StartKnowledgeBaseIndexing` request without `endpoint`, which the bound
 * bookshelf (its `bookshelfUri`) supplies.
 */
export interface StartKnowledgeBaseIndexingRequest extends Omit<
  discovery.StartKnowledgeBaseIndexingRequest,
  "endpoint"
> {}

/**
 * Start indexing a knowledge base.
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
 * Provide {@link StartKnowledgeBaseIndexingHttp}.
 *
 * ### Calling StartKnowledgeBaseIndexing
 * **Example:** StartKnowledgeBaseIndexing from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const startKnowledgeBaseIndexing = yield* Azure.Discovery.StartKnowledgeBaseIndexing(bookshelf);
 *
 * // runtime
 * const result = yield* startKnowledgeBaseIndexing({ knowledgeBaseName: "papers" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.StartKnowledgeBaseIndexingHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface StartKnowledgeBaseIndexing extends Binding.Service<
  StartKnowledgeBaseIndexing,
  "Azure.Discovery.StartKnowledgeBaseIndexing",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request: StartKnowledgeBaseIndexingRequest,
    ) => Effect.Effect<
      discovery.StartKnowledgeBaseIndexingResponse,
      discovery.StartKnowledgeBaseIndexingError,
      RuntimeContext
    >
  >
> {}

export const StartKnowledgeBaseIndexing = Binding.Service<StartKnowledgeBaseIndexing>(
  "Azure.Discovery.StartKnowledgeBaseIndexing",
);
