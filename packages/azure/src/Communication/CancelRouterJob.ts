import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface CancelRouterJobRequest extends Omit<
  jobRouter.CancelJobRouterOperationJobRequest,
  "endpoint"
> {}

/**
 * Cancel a Job Router job, with an optional note and disposition code.
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
 * Provide {@link CancelRouterJobHttp}.
 *
 * ### Calling CancelRouterJob
 * **Example:** CancelRouterJob from a Function
 * ```typescript
 * // init
 * const cancelRouterJob = yield* Azure.Communication.CancelRouterJob(acs);
 *
 * // runtime
 * yield* cancelRouterJob({ jobId: "ticket-42", note: "customer hung up" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface CancelRouterJob extends Binding.Service<
  CancelRouterJob,
  "Azure.Communication.CancelRouterJob",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: CancelRouterJobRequest,
    ) => Effect.Effect<
      jobRouter.CancelJobRouterOperationJobResponse,
      jobRouter.CancelJobRouterOperationJobError,
      RuntimeContext
    >
  >
> {}

export const CancelRouterJob = Binding.Service<CancelRouterJob>(
  "Azure.Communication.CancelRouterJob",
);
