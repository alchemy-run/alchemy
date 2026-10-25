import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRouterExceptionPoliciesRequest extends Omit<
  jobRouter.ListJobRouterAdministrationOperationExceptionPoliciesRequest,
  "endpoint"
> {}

/**
 * List Job Router exception policies, one page per call (pass the previous
 * page's `nextLink` for the next).
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
 * Provide {@link ListRouterExceptionPoliciesHttp}.
 *
 * ### Calling ListRouterExceptionPolicies
 * **Example:** ListRouterExceptionPolicies from a Function
 * ```typescript
 * // init
 * const listRouterExceptionPolicies = yield* Azure.Communication.ListRouterExceptionPolicies(acs);
 *
 * // runtime
 * const page = yield* listRouterExceptionPolicies();
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRouterExceptionPolicies extends Binding.Service<
  ListRouterExceptionPolicies,
  "Azure.Communication.ListRouterExceptionPolicies",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListRouterExceptionPoliciesRequest,
    ) => Effect.Effect<
      jobRouter.PagedExceptionPolicy,
      jobRouter.ListJobRouterAdministrationOperationExceptionPoliciesError,
      RuntimeContext
    >
  >
> {}

export const ListRouterExceptionPolicies = Binding.Service<ListRouterExceptionPolicies>(
  "Azure.Communication.ListRouterExceptionPolicies",
);
