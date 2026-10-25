import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeclineRouterJobOffer } from "./DeclineRouterJobOffer.ts";

/**
 * Implementation of {@link DeclineRouterJobOffer} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.DeclineRouterJobOffer
 */
export const DeclineRouterJobOfferHttp = Layer.effect(
  DeclineRouterJobOffer,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeclineRouterJobOffer",
    operation: jobRouter.JobRouterOperationsDeclineJobOffer,
    grant: CommunicationRole.Data,
  }),
);
