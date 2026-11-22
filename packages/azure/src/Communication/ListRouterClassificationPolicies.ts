import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListRouterClassificationPoliciesRequest extends Omit<
  jobRouter.ListJobRouterAdministrationOperationClassificationPoliciesRequest,
  "endpoint"
> {}

/**
 * List Job Router classification policies, one page per call (pass the
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
 * Provide {@link ListRouterClassificationPoliciesHttp}.
 *
 * ### Calling ListRouterClassificationPolicies
 * **Example:** ListRouterClassificationPolicies from a Function
 * ```typescript
 * // init
 * const listRouterClassificationPolicies = yield* Azure.Communication.ListRouterClassificationPolicies(acs);
 *
 * // runtime
 * const page = yield* listRouterClassificationPolicies();
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListRouterClassificationPolicies extends Binding.Service<
  ListRouterClassificationPolicies,
  "Azure.Communication.ListRouterClassificationPolicies",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListRouterClassificationPoliciesRequest,
    ) => Effect.Effect<
      jobRouter.PagedClassificationPolicy,
      jobRouter.ListJobRouterAdministrationOperationClassificationPoliciesError,
      RuntimeContext
    >
  >
> {}

export const ListRouterClassificationPolicies = Binding.Service<ListRouterClassificationPolicies>(
  "Azure.Communication.ListRouterClassificationPolicies",
);
