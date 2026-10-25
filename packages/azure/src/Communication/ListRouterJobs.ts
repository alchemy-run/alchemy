import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRouterJobsRequest extends Omit<
  jobRouter.ListJobRouterOperationJobsRequest,
  "endpoint"
> {}

/**
 * List Job Router jobs, filtered by status, queue, channel, or schedule; one
 * page per call (pass the previous page's `nextLink` for the next).
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
 * Provide {@link ListRouterJobsHttp}.
 *
 * ### Calling ListRouterJobs
 * **Example:** ListRouterJobs from a Function
 * ```typescript
 * // init
 * const listRouterJobs = yield* Azure.Communication.ListRouterJobs(acs);
 *
 * // runtime
 * const page = yield* listRouterJobs({ queueId: "support", status: "queued" });
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRouterJobs extends Binding.Service<
  ListRouterJobs,
  "Azure.Communication.ListRouterJobs",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListRouterJobsRequest,
    ) => Effect.Effect<
      jobRouter.PagedRouterJob,
      jobRouter.ListJobRouterOperationJobsError,
      RuntimeContext
    >
  >
> {}

export const ListRouterJobs = Binding.Service<ListRouterJobs>("Azure.Communication.ListRouterJobs");
