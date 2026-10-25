import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ReclassifyRouterJobRequest extends Omit<
  jobRouter.JobRouterOperationsReclassifyJobRequest,
  "endpoint"
> {}

/**
 * Run a Job Router job through its classification policy again.
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
 * Provide {@link ReclassifyRouterJobHttp}.
 *
 * ### Calling ReclassifyRouterJob
 * **Example:** ReclassifyRouterJob from a Function
 * ```typescript
 * // init
 * const reclassifyRouterJob = yield* Azure.Communication.ReclassifyRouterJob(acs);
 *
 * // runtime
 * yield* reclassifyRouterJob({ jobId: "ticket-42" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ReclassifyRouterJob extends Binding.Service<
  ReclassifyRouterJob,
  "Azure.Communication.ReclassifyRouterJob",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ReclassifyRouterJobRequest,
    ) => Effect.Effect<
      jobRouter.JobRouterOperationsReclassifyJobResponse,
      jobRouter.JobRouterOperationsReclassifyJobError,
      RuntimeContext
    >
  >
> {}

export const ReclassifyRouterJob = Binding.Service<ReclassifyRouterJob>(
  "Azure.Communication.ReclassifyRouterJob",
);
