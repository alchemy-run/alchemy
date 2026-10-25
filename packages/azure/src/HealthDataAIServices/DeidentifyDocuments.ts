import type * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeidService } from "./DeidService.ts";

/**
 * `DeidentifyDocuments` request without `endpoint`, which the bound
 * de-identification service (its `serviceUrl`) supplies.
 */
export interface DeidentifyDocumentsRequest extends Omit<
  deid.DeidentifyDocumentsRequest,
  "endpoint"
> {}

/**
 * Start a de-identification job over the documents under a blob prefix (`PUT
 * /jobs/{name}`); the service writes the results under the target prefix.
 *
 * Binding assigns a custom role (`AzureDeidBatchWriteRole`, one per stack) with
 * exactly the data action
 * `Microsoft.HealthDataAIServices/DeidServices/Batch/write`, on the bound
 * service only (the built-in **DeID Batch Data Owner** also grants `Batch/read`
 * and `Batch/delete`). The service reads and writes the blobs with its own
 * managed identity: grant that identity **Storage Blob Data Contributor** on
 * the container.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeidentifyDocumentsHttp}.
 *
 * ### Calling DeidentifyDocuments
 * **Example:** DeidentifyDocuments from a Function
 * ```typescript
 * // init
 * const service = yield* Azure.HealthDataAIServices.DeidService("deid", { resourceGroup: group.resourceGroupName });
 * const deidentifyDocuments = yield* Azure.HealthDataAIServices.DeidentifyDocuments(service);
 *
 * // runtime
 * const result = yield* deidentifyDocuments({ name: "notes-1", sourceLocation: { location: containerUrl, prefix: "in/" }, targetLocation: { location: containerUrl, prefix: "out/" } });
 *
 * // layer
 * Effect.provide(Azure.HealthDataAIServices.DeidentifyDocumentsHttp)
 * ```
 *
 * @binding
 * @category HealthDataAIServices
 */
export interface DeidentifyDocuments extends Binding.Service<
  DeidentifyDocuments,
  "Azure.HealthDataAIServices.DeidentifyDocuments",
  (
    service: DeidService,
  ) => Effect.Effect<
    (
      request: DeidentifyDocumentsRequest,
    ) => Effect.Effect<
      deid.DeidentifyDocumentsResponse,
      deid.DeidentifyDocumentsError,
      RuntimeContext
    >
  >
> {}

export const DeidentifyDocuments = Binding.Service<DeidentifyDocuments>(
  "Azure.HealthDataAIServices.DeidentifyDocuments",
);
