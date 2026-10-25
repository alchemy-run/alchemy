import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { TerminateCall } from "./TerminateCall.ts";

/**
 * Implementation of {@link TerminateCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.TerminateCall
 */
export const TerminateCallHttp = Layer.effect(
  TerminateCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.TerminateCall",
    operation: callAutomation.TerminateCallConnectionCall,
    grant: CommunicationRole.Data,
  }),
);
