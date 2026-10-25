import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `KnowledgeBasesCreateOrUpdate` request without `endpoint`, which the bound
 * bookshelf (its `bookshelfUri`) supplies.
 */
export interface CreateOrUpdateKnowledgeBaseRequest extends Omit<
  discovery.KnowledgeBasesCreateOrUpdateRequest,
  "endpoint"
> {}

/**
 * Create or update a knowledge base (`PATCH /knowledgeBases/{name}`).
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
 * Provide {@link CreateOrUpdateKnowledgeBaseHttp}.
 *
 * ### Calling CreateOrUpdateKnowledgeBase
 * **Example:** CreateOrUpdateKnowledgeBase from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const createOrUpdateKnowledgeBase = yield* Azure.Discovery.CreateOrUpdateKnowledgeBase(bookshelf);
 *
 * // runtime
 * const result = yield* createOrUpdateKnowledgeBase({ knowledgeBaseName: "papers" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.CreateOrUpdateKnowledgeBaseHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface CreateOrUpdateKnowledgeBase extends Binding.Service<
  CreateOrUpdateKnowledgeBase,
  "Azure.Discovery.CreateOrUpdateKnowledgeBase",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateKnowledgeBaseRequest,
    ) => Effect.Effect<
      discovery.KnowledgeBasesCreateOrUpdateResponse,
      discovery.KnowledgeBasesCreateOrUpdateError,
      RuntimeContext
    >
  >
> {}

export const CreateOrUpdateKnowledgeBase = Binding.Service<CreateOrUpdateKnowledgeBase>(
  "Azure.Discovery.CreateOrUpdateKnowledgeBase",
);
