import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterJobRequest extends Omit<
  jobRouter.GetJobRouterOperationJobRequest,
  "endpoint"
> {}

/**
 * Read a Job Router job.
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetRouterJobHttp}.
 *
 * ### Calling GetRouterJob
 * **Example:** GetRouterJob from a Function
 * ```typescript
 * // init
 * const getRouterJob = yield* Azure.Communication.GetRouterJob(acs);
 *
 * // runtime
 * const job = yield* getRouterJob({ jobId: "ticket-42" });
 * // job.status, job.assignments
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterJob extends Binding.Service<
  GetRouterJob,
  "Azure.Communication.GetRouterJob",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterJobRequest,
    ) => Effect.Effect<
      jobRouter.GetJobRouterOperationJobResponse,
      jobRouter.GetJobRouterOperationJobError,
      RuntimeContext
    >
  >
> {}

export const GetRouterJob = Binding.Service<GetRouterJob>("Azure.Communication.GetRouterJob");
