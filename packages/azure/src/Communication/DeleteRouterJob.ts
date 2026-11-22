import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeleteRouterJobRequest extends Omit<
  jobRouter.DeleteJobRouterOperationJobRequest,
  "endpoint"
> {}

/**
 * Delete a Job Router job and its history. Only a job that is not in
 * progress can be deleted.
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
 * Provide {@link DeleteRouterJobHttp}.
 *
 * ### Calling DeleteRouterJob
 * **Example:** DeleteRouterJob from a Function
 * ```typescript
 * // init
 * const deleteRouterJob = yield* Azure.Communication.DeleteRouterJob(acs);
 *
 * // runtime
 * yield* deleteRouterJob({ jobId: "ticket-42" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteRouterJob extends Binding.Service<
  DeleteRouterJob,
  "Azure.Communication.DeleteRouterJob",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteRouterJobRequest,
    ) => Effect.Effect<
      jobRouter.DeleteJobRouterOperationJobResponse,
      jobRouter.DeleteJobRouterOperationJobError,
      RuntimeContext
    >
  >
> {}

export const DeleteRouterJob = Binding.Service<DeleteRouterJob>(
  "Azure.Communication.DeleteRouterJob",
);
