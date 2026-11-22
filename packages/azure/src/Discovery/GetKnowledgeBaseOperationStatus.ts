import type * as discovery from "@distilled.cloud/azure/discovery-bookshelf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bookshelf } from "./Bookshelf.ts";

/**
 * `GetKnowledgeBaseOperationStatus` request without `endpoint`, which the bound
 * bookshelf (its `bookshelfUri`) supplies.
 */
export interface GetKnowledgeBaseOperationStatusRequest extends Omit<
  discovery.GetKnowledgeBaseOperationStatusRequest,
  "endpoint"
> {}

/**
 * Read the status of a knowledge base's long-running operation.
 *
 * Binding assigns the built-in **Microsoft Discovery Bookshelf Index Data
 * Reader** role (data actions `bookshelf/knowledgebases/read`,
 * `bookshelf/knowledgebases/operations/read` and
 * `bookshelf/knowledgeBaseVersions/query/action`) on the bound bookshelf only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetKnowledgeBaseOperationStatusHttp}.
 *
 * ### Calling GetKnowledgeBaseOperationStatus
 * **Example:** GetKnowledgeBaseOperationStatus from a Function
 * ```typescript
 * // init
 * const bookshelf = yield* Azure.Discovery.Bookshelf("library", {});
 * const getKnowledgeBaseOperationStatus = yield* Azure.Discovery.GetKnowledgeBaseOperationStatus(bookshelf);
 *
 * // runtime
 * const result = yield* getKnowledgeBaseOperationStatus({ knowledgeBaseName: "papers", operationId });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetKnowledgeBaseOperationStatusHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetKnowledgeBaseOperationStatus extends Binding.Service<
  GetKnowledgeBaseOperationStatus,
  "Azure.Discovery.GetKnowledgeBaseOperationStatus",
  (
    bookshelf: Bookshelf,
  ) => Effect.Effect<
    (
      request: GetKnowledgeBaseOperationStatusRequest,
    ) => Effect.Effect<
      discovery.KnowledgeBaseOperationResponse,
      discovery.GetKnowledgeBaseOperationStatusError,
      RuntimeContext
    >
  >
> {}

export const GetKnowledgeBaseOperationStatus = Binding.Service<GetKnowledgeBaseOperationStatus>(
  "Azure.Discovery.GetKnowledgeBaseOperationStatus",
);
