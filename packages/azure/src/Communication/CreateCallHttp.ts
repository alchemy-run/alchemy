import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CreateCall } from "./CreateCall.ts";

/**
 * Implementation of {@link CreateCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.CreateCall
 */
export const CreateCallHttp = Layer.effect(
  CreateCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CreateCall",
    operation: callAutomation.CreateCall,
    grant: CommunicationRole.Data,
  }),
);
