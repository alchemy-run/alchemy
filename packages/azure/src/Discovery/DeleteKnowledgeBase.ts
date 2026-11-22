import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `DeleteKnowledgeBase` request without `endpoint`, which the bound bookshelf
 * (its `bookshelfUri`) supplies.
 */
export interface DeleteKnowledgeBaseRequest extends Omit<
  discovery.DeleteKnowledgeBaseRequest,
  "endpoint"
> {}

/**
 * Delete a knowledge base.
 *
 * Binding assigns a custom role (`AzureDiscoveryKnowledgeBaseDeleteRole`, one
 * per stack) with exactly the data action
 * `Microsoft.Discovery/bookshelf/knowledgebases/delete`, on the bound bookshelf
 * only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteKnowledgeBaseHttp}.
 *
 * ### Calling DeleteKnowledgeBase
 * **Example:** DeleteKnowledgeBase from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const deleteKnowledgeBase = yield* Azure.Discovery.DeleteKnowledgeBase(bookshelf);
 *
 * // runtime
 * const result = yield* deleteKnowledgeBase({ knowledgeBaseName: "papers" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.DeleteKnowledgeBaseHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface DeleteKnowledgeBase extends Binding.Service<
  DeleteKnowledgeBase,
  "Azure.Discovery.DeleteKnowledgeBase",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request: DeleteKnowledgeBaseRequest,
    ) => Effect.Effect<
      discovery.DeleteKnowledgeBaseResponse,
      discovery.DeleteKnowledgeBaseError,
      RuntimeContext
    >
  >
> {}

export const DeleteKnowledgeBase = Binding.Service<DeleteKnowledgeBase>(
  "Azure.Discovery.DeleteKnowledgeBase",
);
