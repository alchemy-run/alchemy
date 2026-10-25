import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRouterWorkersRequest extends Omit<
  jobRouter.ListJobRouterOperationWorkersRequest,
  "endpoint"
> {}

/**
 * List Job Router workers, filtered by state, channel, queue, or capacity;
 * one page per call (pass the previous page's `nextLink` for the next).
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
 * Provide {@link ListRouterWorkersHttp}.
 *
 * ### Calling ListRouterWorkers
 * **Example:** ListRouterWorkers from a Function
 * ```typescript
 * // init
 * const listRouterWorkers = yield* Azure.Communication.ListRouterWorkers(acs);
 *
 * // runtime
 * const page = yield* listRouterWorkers({ queueId: "support", hasCapacity: true });
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRouterWorkers extends Binding.Service<
  ListRouterWorkers,
  "Azure.Communication.ListRouterWorkers",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListRouterWorkersRequest,
    ) => Effect.Effect<
      jobRouter.PagedRouterWorker,
      jobRouter.ListJobRouterOperationWorkersError,
      RuntimeContext
    >
  >
> {}

export const ListRouterWorkers = Binding.Service<ListRouterWorkers>(
  "Azure.Communication.ListRouterWorkers",
);
