import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeleteRouterDistributionPolicyRequest extends Omit<
  jobRouter.DeleteJobRouterAdministrationOperationDistributionPolicyRequest,
  "endpoint"
> {}

/**
 * Delete a Job Router distribution policy.
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
 * Provide {@link DeleteRouterDistributionPolicyHttp}.
 *
 * ### Calling DeleteRouterDistributionPolicy
 * **Example:** DeleteRouterDistributionPolicy from a Function
 * ```typescript
 * // init
 * const deleteRouterDistributionPolicy = yield* Azure.Communication.DeleteRouterDistributionPolicy(acs);
 *
 * // runtime
 * yield* deleteRouterDistributionPolicy({ distributionPolicyId: "longest-idle" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteRouterDistributionPolicy extends Binding.Service<
  DeleteRouterDistributionPolicy,
  "Azure.Communication.DeleteRouterDistributionPolicy",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteRouterDistributionPolicyRequest,
    ) => Effect.Effect<
      jobRouter.DeleteJobRouterAdministrationOperationDistributionPolicyResponse,
      jobRouter.DeleteJobRouterAdministrationOperationDistributionPolicyError,
      RuntimeContext
    >
  >
> {}

export const DeleteRouterDistributionPolicy = Binding.Service<DeleteRouterDistributionPolicy>(
  "Azure.Communication.DeleteRouterDistributionPolicy",
);
