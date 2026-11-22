import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ConnectCall } from "./ConnectCall.ts";

/**
 * Implementation of {@link ConnectCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ConnectCall
 */
export const ConnectCallHttp = Layer.effect(
  ConnectCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ConnectCall",
    operation: callAutomation.Connect,
    grant: CommunicationRole.Data,
  }),
);
