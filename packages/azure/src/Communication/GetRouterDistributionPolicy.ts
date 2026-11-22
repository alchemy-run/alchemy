import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterDistributionPolicyRequest extends Omit<
  jobRouter.GetJobRouterAdministrationOperationDistributionPolicyRequest,
  "endpoint"
> {}

/**
 * Read a Job Router distribution policy.
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
 * Provide {@link GetRouterDistributionPolicyHttp}.
 *
 * ### Calling GetRouterDistributionPolicy
 * **Example:** GetRouterDistributionPolicy from a Function
 * ```typescript
 * // init
 * const getRouterDistributionPolicy = yield* Azure.Communication.GetRouterDistributionPolicy(acs);
 *
 * // runtime
 * const policy = yield* getRouterDistributionPolicy({ distributionPolicyId: "longest-idle" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterDistributionPolicy extends Binding.Service<
  GetRouterDistributionPolicy,
  "Azure.Communication.GetRouterDistributionPolicy",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterDistributionPolicyRequest,
    ) => Effect.Effect<
      jobRouter.GetJobRouterAdministrationOperationDistributionPolicyResponse,
      jobRouter.GetJobRouterAdministrationOperationDistributionPolicyError,
      RuntimeContext
    >
  >
> {}

export const GetRouterDistributionPolicy = Binding.Service<GetRouterDistributionPolicy>(
  "Azure.Communication.GetRouterDistributionPolicy",
);
