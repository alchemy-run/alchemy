import type * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeidService } from "./DeidService.ts";

/**
 * `CancelJob` request without `endpoint`, which the bound de-identification
 * service (its `serviceUrl`) supplies.
 */
export interface CancelJobRequest extends Omit<deid.CancelJobRequest, "endpoint"> {}

/**
 * Cancel a de-identification job that is in progress; documents already
 * processed stay in place.
 *
 * Binding assigns a custom role (`AzureDeidBatchWriteRole`, one per stack) with
 * exactly the data action
 * `Microsoft.HealthDataAIServices/DeidServices/Batch/write`, on the bound
 * service only (the built-in **DeID Batch Data Owner** also grants `Batch/read`
 * and `Batch/delete`).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelJobHttp}.
 *
 * ### Calling CancelJob
 * **Example:** CancelJob from a Function
 * ```typescript
 * // init
 * const service = yield* Azure.HealthDataAIServices.DeidService("deid", { resourceGroup: group.resourceGroupName });
 * const cancelJob = yield* Azure.HealthDataAIServices.CancelJob(service);
 *
 * // runtime
 * const result = yield* cancelJob({ name: "notes-1" });
 *
 * // layer
 * Effect.provide(Azure.HealthDataAIServices.CancelJobHttp)
 * ```
 *
 * @binding
 * @category HealthDataAIServices
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "Azure.HealthDataAIServices.CancelJob",
  (
    service: DeidService,
  ) => Effect.Effect<
    (
      request: CancelJobRequest,
    ) => Effect.Effect<deid.DeidentificationJob, deid.CancelJobError, RuntimeContext>
  >
> {}

export const CancelJob = Binding.Service<CancelJob>("Azure.HealthDataAIServices.CancelJob");
