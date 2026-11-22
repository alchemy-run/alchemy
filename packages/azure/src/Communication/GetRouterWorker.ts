import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterWorkerRequest extends Omit<
  jobRouter.GetJobRouterOperationWorkerRequest,
  "endpoint"
> {}

/**
 * Read a Job Router worker, including its open offers.
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
 * Provide {@link GetRouterWorkerHttp}.
 *
 * ### Calling GetRouterWorker
 * **Example:** GetRouterWorker from a Function
 * ```typescript
 * // init
 * const getRouterWorker = yield* Azure.Communication.GetRouterWorker(acs);
 *
 * // runtime
 * const worker = yield* getRouterWorker({ workerId: "agent-7" });
 * // worker.state, worker.offers
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterWorker extends Binding.Service<
  GetRouterWorker,
  "Azure.Communication.GetRouterWorker",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterWorkerRequest,
    ) => Effect.Effect<
      jobRouter.GetJobRouterOperationWorkerResponse,
      jobRouter.GetJobRouterOperationWorkerError,
      RuntimeContext
    >
  >
> {}

export const GetRouterWorker = Binding.Service<GetRouterWorker>(
  "Azure.Communication.GetRouterWorker",
);
