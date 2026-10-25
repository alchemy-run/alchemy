import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRouterDistributionPoliciesRequest extends Omit<
  jobRouter.ListJobRouterAdministrationOperationDistributionPoliciesRequest,
  "endpoint"
> {}

/**
 * List Job Router distribution policies, one page per call (pass the
 * previous page's `nextLink` for the next).
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
 * Provide {@link ListRouterDistributionPoliciesHttp}.
 *
 * ### Calling ListRouterDistributionPolicies
 * **Example:** ListRouterDistributionPolicies from a Function
 * ```typescript
 * // init
 * const listRouterDistributionPolicies = yield* Azure.Communication.ListRouterDistributionPolicies(acs);
 *
 * // runtime
 * const page = yield* listRouterDistributionPolicies();
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRouterDistributionPolicies extends Binding.Service<
  ListRouterDistributionPolicies,
  "Azure.Communication.ListRouterDistributionPolicies",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListRouterDistributionPoliciesRequest,
    ) => Effect.Effect<
      jobRouter.PagedDistributionPolicy,
      jobRouter.ListJobRouterAdministrationOperationDistributionPoliciesError,
      RuntimeContext
    >
  >
> {}

export const ListRouterDistributionPolicies = Binding.Service<ListRouterDistributionPolicies>(
  "Azure.Communication.ListRouterDistributionPolicies",
);
