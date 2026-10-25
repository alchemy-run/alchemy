import type * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeidService } from "./DeidService.ts";

/**
 * `DeleteJob` request without `endpoint`, which the bound de-identification
 * service (its `serviceUrl`) supplies.
 */
export interface DeleteJobRequest extends Omit<deid.DeleteJobRequest, "endpoint"> {}

/**
 * Delete a de-identification job record; the documents stay in storage.
 *
 * Binding assigns a custom role (`AzureDeidBatchDeleteRole`, one per stack)
 * with exactly the data action
 * `Microsoft.HealthDataAIServices/DeidServices/Batch/delete`, on the bound
 * service only (the built-in **DeID Batch Data Owner** also grants `Batch/read`
 * and `Batch/write`).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteJobHttp}.
 *
 * ### Calling DeleteJob
 * **Example:** DeleteJob from a Function
 * ```typescript
 * // init
 * const service = yield* Azure.HealthDataAIServices.DeidService("deid", { resourceGroup: group.resourceGroupName });
 * const deleteJob = yield* Azure.HealthDataAIServices.DeleteJob(service);
 *
 * // runtime
 * const result = yield* deleteJob({ name: "notes-1" });
 *
 * // layer
 * Effect.provide(Azure.HealthDataAIServices.DeleteJobHttp)
 * ```
 *
 * @binding
 * @category HealthDataAIServices
 */
export interface DeleteJob extends Binding.Service<
  DeleteJob,
  "Azure.HealthDataAIServices.DeleteJob",
  (
    service: DeidService,
  ) => Effect.Effect<
    (
      request: DeleteJobRequest,
    ) => Effect.Effect<deid.DeleteJobResponse, deid.DeleteJobError, RuntimeContext>
  >
> {}

export const DeleteJob = Binding.Service<DeleteJob>("Azure.HealthDataAIServices.DeleteJob");
