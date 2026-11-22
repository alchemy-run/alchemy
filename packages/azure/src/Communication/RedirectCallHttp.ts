import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { RedirectCall } from "./RedirectCall.ts";

/**
 * Implementation of {@link RedirectCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.RedirectCall
 */
export const RedirectCallHttp = Layer.effect(
  RedirectCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.RedirectCall",
    operation: callAutomation.RedirectCall,
    grant: CommunicationRole.Data,
  }),
);
