import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { RecognizeCallMedia } from "./RecognizeCallMedia.ts";

/**
 * Implementation of {@link RecognizeCallMedia} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.RecognizeCallMedia
 */
export const RecognizeCallMediaHttp = Layer.effect(
  RecognizeCallMedia,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.RecognizeCallMedia",
    operation: callAutomation.CallMediaRecognize,
    grant: CommunicationRole.Data,
  }),
);
