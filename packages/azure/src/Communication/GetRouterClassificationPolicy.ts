import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetRouterClassificationPolicyRequest extends Omit<
  jobRouter.GetJobRouterAdministrationOperationClassificationPolicyRequest,
  "endpoint"
> {}

/**
 * Read a Job Router classification policy.
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
 * Provide {@link GetRouterClassificationPolicyHttp}.
 *
 * ### Calling GetRouterClassificationPolicy
 * **Example:** GetRouterClassificationPolicy from a Function
 * ```typescript
 * // init
 * const getRouterClassificationPolicy = yield* Azure.Communication.GetRouterClassificationPolicy(acs);
 *
 * // runtime
 * const policy = yield* getRouterClassificationPolicy({ classificationPolicyId: "default" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetRouterClassificationPolicy extends Binding.Service<
  GetRouterClassificationPolicy,
  "Azure.Communication.GetRouterClassificationPolicy",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetRouterClassificationPolicyRequest,
    ) => Effect.Effect<
      jobRouter.GetJobRouterAdministrationOperationClassificationPolicyResponse,
      jobRouter.GetJobRouterAdministrationOperationClassificationPolicyError,
      RuntimeContext
    >
  >
> {}

export const GetRouterClassificationPolicy = Binding.Service<GetRouterClassificationPolicy>(
  "Azure.Communication.GetRouterClassificationPolicy",
);
