import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeleteRouterWorkerRequest extends Omit<
  jobRouter.DeleteJobRouterOperationWorkerRequest,
  "endpoint"
> {}

/**
 * Delete a Job Router worker and its history.
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
 * Provide {@link DeleteRouterWorkerHttp}.
 *
 * ### Calling DeleteRouterWorker
 * **Example:** DeleteRouterWorker from a Function
 * ```typescript
 * // init
 * const deleteRouterWorker = yield* Azure.Communication.DeleteRouterWorker(acs);
 *
 * // runtime
 * yield* deleteRouterWorker({ workerId: "agent-7" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteRouterWorker extends Binding.Service<
  DeleteRouterWorker,
  "Azure.Communication.DeleteRouterWorker",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteRouterWorkerRequest,
    ) => Effect.Effect<
      jobRouter.DeleteJobRouterOperationWorkerResponse,
      jobRouter.DeleteJobRouterOperationWorkerError,
      RuntimeContext
    >
  >
> {}

export const DeleteRouterWorker = Binding.Service<DeleteRouterWorker>(
  "Azure.Communication.DeleteRouterWorker",
);
