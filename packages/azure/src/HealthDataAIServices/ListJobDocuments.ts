import type * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeidService } from "./DeidService.ts";

/**
 * `ListJobDocuments` request without `endpoint`, which the bound
 * de-identification service (its `serviceUrl`) supplies.
 */
export interface ListJobDocumentsRequest extends Omit<deid.ListJobDocumentsRequest, "endpoint"> {}

/**
 * List the documents a de-identification job processed, with their status and
 * output location. One page per call: pass `nextLink` for the next.
 *
 * Binding assigns the built-in **DeID Batch Data Reader** role (data action
 * `Microsoft.HealthDataAIServices/DeidServices/Batch/read` only) on the bound
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListJobDocumentsHttp}.
 *
 * ### Calling ListJobDocuments
 * **Example:** ListJobDocuments from a Function
 * ```typescript
 * // init
 * const service = yield* Azure.HealthDataAIServices.DeidService("deid", { resourceGroup: group.resourceGroupName });
 * const listJobDocuments = yield* Azure.HealthDataAIServices.ListJobDocuments(service);
 *
 * // runtime
 * const result = yield* listJobDocuments({ name: "notes-1" });
 *
 * // layer
 * Effect.provide(Azure.HealthDataAIServices.ListJobDocumentsHttp)
 * ```
 *
 * @binding
 * @category HealthDataAIServices
 */
export interface ListJobDocuments extends Binding.Service<
  ListJobDocuments,
  "Azure.HealthDataAIServices.ListJobDocuments",
  (
    service: DeidService,
  ) => Effect.Effect<
    (
      request: ListJobDocumentsRequest,
    ) => Effect.Effect<
      deid.PagedDeidentificationDocumentDetails,
      deid.ListJobDocumentsError,
      RuntimeContext
    >
  >
> {}

export const ListJobDocuments = Binding.Service<ListJobDocuments>(
  "Azure.HealthDataAIServices.ListJobDocuments",
);
