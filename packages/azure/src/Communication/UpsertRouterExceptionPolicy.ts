import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpsertRouterExceptionPolicyRequest extends Omit<
  jobRouter.UpsertJobRouterAdministrationOperationExceptionPolicyRequest,
  "endpoint"
> {}

/**
 * Create or update a Job Router exception policy: what happens when a job
 * waits too long or matches nobody.
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
 * Provide {@link UpsertRouterExceptionPolicyHttp}.
 *
 * ### Calling UpsertRouterExceptionPolicy
 * **Example:** UpsertRouterExceptionPolicy from a Function
 * ```typescript
 * // init
 * const upsertRouterExceptionPolicy = yield* Azure.Communication.UpsertRouterExceptionPolicy(acs);
 *
 * // runtime
 * yield* upsertRouterExceptionPolicy({
 *   exceptionPolicyId: "escalate",
 *   exceptionRules: [
 *     {
 *       id: "wait-5m",
 *       trigger: { kind: "waitTime", thresholdSeconds: 300 },
 *       actions: [{ kind: "reclassify", classificationPolicyId: "priority" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpsertRouterExceptionPolicy extends Binding.Service<
  UpsertRouterExceptionPolicy,
  "Azure.Communication.UpsertRouterExceptionPolicy",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpsertRouterExceptionPolicyRequest,
    ) => Effect.Effect<
      jobRouter.UpsertJobRouterAdministrationOperationExceptionPolicyResponse,
      jobRouter.UpsertJobRouterAdministrationOperationExceptionPolicyError,
      RuntimeContext
    >
  >
> {}

export const UpsertRouterExceptionPolicy = Binding.Service<UpsertRouterExceptionPolicy>(
  "Azure.Communication.UpsertRouterExceptionPolicy",
);
