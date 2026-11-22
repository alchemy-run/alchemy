import type * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeclineRouterJobOfferRequest extends Omit<
  jobRouter.JobRouterOperationsDeclineJobOfferRequest,
  "endpoint"
> {}

/**
 * Decline a job offer for a worker.
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
 * Provide {@link DeclineRouterJobOfferHttp}.
 *
 * ### Calling DeclineRouterJobOffer
 * **Example:** DeclineRouterJobOffer from a Function
 * ```typescript
 * // init
 * const declineRouterJobOffer = yield* Azure.Communication.DeclineRouterJobOffer(acs);
 *
 * // runtime
 * yield* declineRouterJobOffer({ workerId: "agent-7", offerId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeclineRouterJobOffer extends Binding.Service<
  DeclineRouterJobOffer,
  "Azure.Communication.DeclineRouterJobOffer",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeclineRouterJobOfferRequest,
    ) => Effect.Effect<
      jobRouter.JobRouterOperationsDeclineJobOfferResponse,
      jobRouter.JobRouterOperationsDeclineJobOfferError,
      RuntimeContext
    >
  >
> {}

export const DeclineRouterJobOffer = Binding.Service<DeclineRouterJobOffer>(
  "Azure.Communication.DeclineRouterJobOffer",
);
