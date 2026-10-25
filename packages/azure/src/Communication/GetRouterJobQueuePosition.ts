import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterJobQueuePositionRequest extends Omit<
  jobRouter.GetJobRouterOperationInQueuePositionRequest,
  "endpoint"
> {}

/**
 * Read a queued Job Router job's position and estimated wait.
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
 * Provide {@link GetRouterJobQueuePositionHttp}.
 *
 * ### Calling GetRouterJobQueuePosition
 * **Example:** GetRouterJobQueuePosition from a Function
 * ```typescript
 * // init
 * const getRouterJobQueuePosition = yield* Azure.Communication.GetRouterJobQueuePosition(acs);
 *
 * // runtime
 * const position = yield* getRouterJobQueuePosition({ jobId: "ticket-42" });
 * // position.position, position.estimatedWaitTimeMinutes
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterJobQueuePosition extends Binding.Service<
  GetRouterJobQueuePosition,
  "Azure.Communication.GetRouterJobQueuePosition",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterJobQueuePositionRequest,
    ) => Effect.Effect<
      jobRouter.RouterJobPositionDetails,
      jobRouter.GetJobRouterOperationInQueuePositionError,
      RuntimeContext
    >
  >
> {}

export const GetRouterJobQueuePosition = Binding.Service<GetRouterJobQueuePosition>(
  "Azure.Communication.GetRouterJobQueuePosition",
);
