import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterExceptionPolicyRequest extends Omit<
  jobRouter.GetJobRouterAdministrationOperationExceptionPolicyRequest,
  "endpoint"
> {}

/**
 * Read a Job Router exception policy.
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
 * Provide {@link GetRouterExceptionPolicyHttp}.
 *
 * ### Calling GetRouterExceptionPolicy
 * **Example:** GetRouterExceptionPolicy from a Function
 * ```typescript
 * // init
 * const getRouterExceptionPolicy = yield* Azure.Communication.GetRouterExceptionPolicy(acs);
 *
 * // runtime
 * const policy = yield* getRouterExceptionPolicy({ exceptionPolicyId: "escalate" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterExceptionPolicy extends Binding.Service<
  GetRouterExceptionPolicy,
  "Azure.Communication.GetRouterExceptionPolicy",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterExceptionPolicyRequest,
    ) => Effect.Effect<
      jobRouter.GetJobRouterAdministrationOperationExceptionPolicyResponse,
      jobRouter.GetJobRouterAdministrationOperationExceptionPolicyError,
      RuntimeContext
    >
  >
> {}

export const GetRouterExceptionPolicy = Binding.Service<GetRouterExceptionPolicy>(
  "Azure.Communication.GetRouterExceptionPolicy",
);
