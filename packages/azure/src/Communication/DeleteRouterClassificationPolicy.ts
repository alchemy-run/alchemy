import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeleteRouterClassificationPolicyRequest extends Omit<
  jobRouter.DeleteJobRouterAdministrationOperationClassificationPolicyRequest,
  "endpoint"
> {}

/**
 * Delete a Job Router classification policy.
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
 * Provide {@link DeleteRouterClassificationPolicyHttp}.
 *
 * ### Calling DeleteRouterClassificationPolicy
 * **Example:** DeleteRouterClassificationPolicy from a Function
 * ```typescript
 * // init
 * const deleteRouterClassificationPolicy = yield* Azure.Communication.DeleteRouterClassificationPolicy(acs);
 *
 * // runtime
 * yield* deleteRouterClassificationPolicy({ classificationPolicyId: "default" });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeleteRouterClassificationPolicy extends Binding.Service<
  DeleteRouterClassificationPolicy,
  "Azure.Communication.DeleteRouterClassificationPolicy",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeleteRouterClassificationPolicyRequest,
    ) => Effect.Effect<
      jobRouter.DeleteJobRouterAdministrationOperationClassificationPolicyResponse,
      jobRouter.DeleteJobRouterAdministrationOperationClassificationPolicyError,
      RuntimeContext
    >
  >
> {}

export const DeleteRouterClassificationPolicy = Binding.Service<DeleteRouterClassificationPolicy>(
  "Azure.Communication.DeleteRouterClassificationPolicy",
);
