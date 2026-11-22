import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface AcceptRouterJobOfferRequest extends Omit<
  jobRouter.AcceptJobRouterOperationJobOfferRequest,
  "endpoint"
> {}

/**
 * Accept a job offer for a worker. Fails with a 409 conflict if another
 * worker accepted the job first.
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
 * Provide {@link AcceptRouterJobOfferHttp}.
 *
 * ### Calling AcceptRouterJobOffer
 * **Example:** AcceptRouterJobOffer from a Function
 * ```typescript
 * // init
 * const acceptRouterJobOffer = yield* Azure.Communication.AcceptRouterJobOffer(acs);
 *
 * // runtime
 * const accepted = yield* acceptRouterJobOffer({ workerId: "agent-7", offerId });
 * // accepted.assignmentId, accepted.jobId
 * ```
 *
 * @binding
 * @category Communication
 */
export interface AcceptRouterJobOffer extends Binding.Service<
  AcceptRouterJobOffer,
  "Azure.Communication.AcceptRouterJobOffer",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: AcceptRouterJobOfferRequest,
    ) => Effect.Effect<
      jobRouter.AcceptJobOfferResult,
      jobRouter.AcceptJobRouterOperationJobOfferError,
      RuntimeContext
    >
  >
> {}

export const AcceptRouterJobOffer = Binding.Service<AcceptRouterJobOffer>(
  "Azure.Communication.AcceptRouterJobOffer",
);
