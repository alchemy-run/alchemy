import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpsertRouterDistributionPolicyRequest extends Omit<
  jobRouter.UpsertJobRouterAdministrationOperationDistributionPolicyRequest,
  "endpoint"
> {}

/**
 * Create or update a Job Router distribution policy: how long offers last
 * and how workers are picked.
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
 * Provide {@link UpsertRouterDistributionPolicyHttp}.
 *
 * ### Calling UpsertRouterDistributionPolicy
 * **Example:** UpsertRouterDistributionPolicy from a Function
 * ```typescript
 * // init
 * const upsertRouterDistributionPolicy = yield* Azure.Communication.UpsertRouterDistributionPolicy(acs);
 *
 * // runtime
 * const policy = yield* upsertRouterDistributionPolicy({
 *   distributionPolicyId: "longest-idle",
 *   offerExpiresAfterSeconds: 60,
 *   mode: { kind: "longestIdle" },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpsertRouterDistributionPolicy extends Binding.Service<
  UpsertRouterDistributionPolicy,
  "Azure.Communication.UpsertRouterDistributionPolicy",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpsertRouterDistributionPolicyRequest,
    ) => Effect.Effect<
      jobRouter.UpsertJobRouterAdministrationOperationDistributionPolicyResponse,
      jobRouter.UpsertJobRouterAdministrationOperationDistributionPolicyError,
      RuntimeContext
    >
  >
> {}

export const UpsertRouterDistributionPolicy = Binding.Service<UpsertRouterDistributionPolicy>(
  "Azure.Communication.UpsertRouterDistributionPolicy",
);
