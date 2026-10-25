import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CloseRouterJobRequest extends Omit<
  jobRouter.JobRouterOperationsCloseJobRequest,
  "endpoint"
> {}

/**
 * Close a completed Job Router job and free the worker's capacity.
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
 * Provide {@link CloseRouterJobHttp}.
 *
 * ### Calling CloseRouterJob
 * **Example:** CloseRouterJob from a Function
 * ```typescript
 * // init
 * const closeRouterJob = yield* Azure.Communication.CloseRouterJob(acs);
 *
 * // runtime
 * yield* closeRouterJob({ jobId: "ticket-42", assignmentId, dispositionCode: "resolved" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CloseRouterJob extends Binding.Service<
  CloseRouterJob,
  "Azure.Communication.CloseRouterJob",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CloseRouterJobRequest,
    ) => Effect.Effect<
      jobRouter.JobRouterOperationsCloseJobResponse,
      jobRouter.JobRouterOperationsCloseJobError,
      RuntimeContext
    >
  >
> {}

export const CloseRouterJob = Binding.Service<CloseRouterJob>("Azure.Communication.CloseRouterJob");
