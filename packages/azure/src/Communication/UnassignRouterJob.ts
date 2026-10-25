import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UnassignRouterJobRequest extends Omit<
  jobRouter.UnassignJobRouterOperationJobRequest,
  "endpoint"
> {}

/**
 * Take an assigned Job Router job back from its worker.
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
 * Provide {@link UnassignRouterJobHttp}.
 *
 * ### Calling UnassignRouterJob
 * **Example:** UnassignRouterJob from a Function
 * ```typescript
 * // init
 * const unassignRouterJob = yield* Azure.Communication.UnassignRouterJob(acs);
 *
 * // runtime
 * yield* unassignRouterJob({ jobId: "ticket-42", assignmentId, suspendMatching: true });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UnassignRouterJob extends Binding.Service<
  UnassignRouterJob,
  "Azure.Communication.UnassignRouterJob",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UnassignRouterJobRequest,
    ) => Effect.Effect<
      jobRouter.UnassignJobResult,
      jobRouter.UnassignJobRouterOperationJobError,
      RuntimeContext
    >
  >
> {}

export const UnassignRouterJob = Binding.Service<UnassignRouterJob>(
  "Azure.Communication.UnassignRouterJob",
);
