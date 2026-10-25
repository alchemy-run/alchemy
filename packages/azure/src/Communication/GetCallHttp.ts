import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetCall } from "./GetCall.ts";

/**
 * Implementation of {@link GetCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetCall
 */
export const GetCallHttp = Layer.effect(
  GetCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetCall",
    operation: callAutomation.GetCallConnectionCall,
    grant: CommunicationRole.Data,
  }),
);
