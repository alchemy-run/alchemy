import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { RejectCall } from "./RejectCall.ts";

/**
 * Implementation of {@link RejectCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.RejectCall
 */
export const RejectCallHttp = Layer.effect(
  RejectCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.RejectCall",
    operation: callAutomation.RejectCall,
    grant: CommunicationRole.Data,
  }),
);
