import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { HangUpCall } from "./HangUpCall.ts";

/**
 * Implementation of {@link HangUpCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.HangUpCall
 */
export const HangUpCallHttp = Layer.effect(
  HangUpCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.HangUpCall",
    operation: callAutomation.CallConnectionHangupCall,
    grant: CommunicationRole.Data,
  }),
);
