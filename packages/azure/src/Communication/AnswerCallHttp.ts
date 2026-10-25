import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { AnswerCall } from "./AnswerCall.ts";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AnswerCall} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.AnswerCall
 */
export const AnswerCallHttp = Layer.effect(
  AnswerCall,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.AnswerCall",
    operation: callAutomation.AnswerCall,
    grant: CommunicationRole.Data,
  }),
);
