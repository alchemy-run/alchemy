import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpsertRouterJobRequest extends Omit<
  jobRouter.UpsertJobRouterOperationJobRequest,
  "endpoint"
> {}

/**
 * Create or update a Job Router job.
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
 * Provide {@link UpsertRouterJobHttp}.
 *
 * ### Calling UpsertRouterJob
 * **Example:** UpsertRouterJob from a Function
 * ```typescript
 * // init
 * const upsertRouterJob = yield* Azure.Communication.UpsertRouterJob(acs);
 *
 * // runtime
 * const job = yield* upsertRouterJob({
 *   jobId: "ticket-42",
 *   channelId: "voice",
 *   queueId: "support",
 *   priority: 1,
 * });
 * // job.status
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpsertRouterJob extends Binding.Service<
  UpsertRouterJob,
  "Azure.Communication.UpsertRouterJob",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpsertRouterJobRequest,
    ) => Effect.Effect<
      jobRouter.UpsertJobRouterOperationJobResponse,
      jobRouter.UpsertJobRouterOperationJobError,
      RuntimeContext
    >
  >
> {}

export const UpsertRouterJob = Binding.Service<UpsertRouterJob>(
  "Azure.Communication.UpsertRouterJob",
);
