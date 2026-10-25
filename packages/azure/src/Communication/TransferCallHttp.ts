import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { TransferCall } from "./TransferCall.ts";

/**
 * Implementation of {@link TransferCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.TransferCall
 */
export const TransferCallHttp = Layer.effect(
  TransferCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.TransferCall",
    operation: callAutomation.TransferCallConnectionToParticipant,
    grant: CommunicationRole.Data,
  }),
);
