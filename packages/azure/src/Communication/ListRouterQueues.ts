import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRouterQueuesRequest extends Omit<
  jobRouter.ListJobRouterAdministrationOperationQueuesRequest,
  "endpoint"
> {}

/**
 * List Job Router queues, one page per call (pass the previous page's
 * `nextLink` for the next).
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
 * Provide {@link ListRouterQueuesHttp}.
 *
 * ### Calling ListRouterQueues
 * **Example:** ListRouterQueues from a Function
 * ```typescript
 * // init
 * const listRouterQueues = yield* Azure.Communication.ListRouterQueues(acs);
 *
 * // runtime
 * const page = yield* listRouterQueues();
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRouterQueues extends Binding.Service<
  ListRouterQueues,
  "Azure.Communication.ListRouterQueues",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListRouterQueuesRequest,
    ) => Effect.Effect<
      jobRouter.PagedRouterQueue,
      jobRouter.ListJobRouterAdministrationOperationQueuesError,
      RuntimeContext
    >
  >
> {}

export const ListRouterQueues = Binding.Service<ListRouterQueues>(
  "Azure.Communication.ListRouterQueues",
);
