import type * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeidService } from "./DeidService.ts";

/**
 * `GetJob` request without `endpoint`, which the bound de-identification
 * service (its `serviceUrl`) supplies.
 */
export interface GetJobRequest extends Omit<deid.GetJobRequest, "endpoint"> {}

/**
 * Read a de-identification job and its status.
 *
 * Binding assigns the built-in **DeID Batch Data Reader** role (data action
 * `Microsoft.HealthDataAIServices/DeidServices/Batch/read` only) on the bound
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetJobHttp}.
 *
 * ### Calling GetJob
 * **Example:** GetJob from a Function
 * ```typescript
 * // init
 * const service = yield* Azure.HealthDataAIServices.DeidService("deid", { resourceGroup: group.resourceGroupName });
 * const getJob = yield* Azure.HealthDataAIServices.GetJob(service);
 *
 * // runtime
 * const result = yield* getJob({ name: "notes-1" });
 *
 * // layer
 * Effect.provide(Azure.HealthDataAIServices.GetJobHttp)
 * ```
 *
 * @binding
 * @category HealthDataAIServices
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "Azure.HealthDataAIServices.GetJob",
  (
    service: DeidService,
  ) => Effect.Effect<
    (
      request: GetJobRequest,
    ) => Effect.Effect<deid.DeidentificationJob, deid.GetJobError, RuntimeContext>
  >
> {}

export const GetJob = Binding.Service<GetJob>("Azure.HealthDataAIServices.GetJob");
