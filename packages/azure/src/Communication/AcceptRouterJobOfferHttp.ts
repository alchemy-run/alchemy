import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { AcceptRouterJobOffer } from "./AcceptRouterJobOffer.ts";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AcceptRouterJobOffer} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.AcceptRouterJobOffer
 */
export const AcceptRouterJobOfferHttp = Layer.effect(
  AcceptRouterJobOffer,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.AcceptRouterJobOffer",
    operation: jobRouter.AcceptJobRouterOperationJobOffer,
    grant: CommunicationRole.Data,
  }),
);
