import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterQueueStatisticsRequest extends Omit<
  jobRouter.GetJobRouterOperationQueueStatisticsRequest,
  "endpoint"
> {}

/**
 * Read a Job Router queue's statistics: job count and wait times.
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
 * Provide {@link GetRouterQueueStatisticsHttp}.
 *
 * ### Calling GetRouterQueueStatistics
 * **Example:** GetRouterQueueStatistics from a Function
 * ```typescript
 * // init
 * const getRouterQueueStatistics = yield* Azure.Communication.GetRouterQueueStatistics(acs);
 *
 * // runtime
 * const stats = yield* getRouterQueueStatistics({ queueId: "support" });
 * // stats.length, stats.longestJobWaitTimeMinutes
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterQueueStatistics extends Binding.Service<
  GetRouterQueueStatistics,
  "Azure.Communication.GetRouterQueueStatistics",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterQueueStatisticsRequest,
    ) => Effect.Effect<
      jobRouter.RouterQueueStatistics,
      jobRouter.GetJobRouterOperationQueueStatisticsError,
      RuntimeContext
    >
  >
> {}

export const GetRouterQueueStatistics = Binding.Service<GetRouterQueueStatistics>(
  "Azure.Communication.GetRouterQueueStatistics",
);
