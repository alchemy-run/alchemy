import type * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeidService } from "./DeidService.ts";

/**
 * `ListJobs` request without `endpoint`, which the bound de-identification
 * service (its `serviceUrl`) supplies.
 */
export interface ListJobsRequest extends Omit<deid.ListJobsRequest, "endpoint"> {}

/**
 * List the service's de-identification jobs. One page per call: pass `nextLink`
 * for the next.
 *
 * Binding assigns the built-in **DeID Batch Data Reader** role (data action
 * `Microsoft.HealthDataAIServices/DeidServices/Batch/read` only) on the bound
 * service.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListJobsHttp}.
 *
 * ### Calling ListJobs
 * **Example:** ListJobs from a Function
 * ```typescript
 * // init
 * const service = yield* Azure.HealthDataAIServices.DeidService("deid", { resourceGroup: group.resourceGroupName });
 * const listJobs = yield* Azure.HealthDataAIServices.ListJobs(service);
 *
 * // runtime
 * const result = yield* listJobs();
 *
 * // layer
 * Effect.provide(Azure.HealthDataAIServices.ListJobsHttp)
 * ```
 *
 * @binding
 * @category HealthDataAIServices
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "Azure.HealthDataAIServices.ListJobs",
  (
    service: DeidService,
  ) => Effect.Effect<
    (
      request?: ListJobsRequest,
    ) => Effect.Effect<deid.PagedDeidentificationJob, deid.ListJobsError, RuntimeContext>
  >
> {}

export const ListJobs = Binding.Service<ListJobs>("Azure.HealthDataAIServices.ListJobs");
