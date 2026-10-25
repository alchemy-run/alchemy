import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterQueueRequest extends Omit<
  jobRouter.GetJobRouterAdministrationOperationQueueRequest,
  "endpoint"
> {}

/**
 * Read a Job Router queue.
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
 * Provide {@link GetRouterQueueHttp}.
 *
 * ### Calling GetRouterQueue
 * **Example:** GetRouterQueue from a Function
 * ```typescript
 * // init
 * const getRouterQueue = yield* Azure.Communication.GetRouterQueue(acs);
 *
 * // runtime
 * const queue = yield* getRouterQueue({ queueId: "support" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterQueue extends Binding.Service<
  GetRouterQueue,
  "Azure.Communication.GetRouterQueue",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterQueueRequest,
    ) => Effect.Effect<
      jobRouter.GetJobRouterAdministrationOperationQueueResponse,
      jobRouter.GetJobRouterAdministrationOperationQueueError,
      RuntimeContext
    >
  >
> {}

export const GetRouterQueue = Binding.Service<GetRouterQueue>("Azure.Communication.GetRouterQueue");
