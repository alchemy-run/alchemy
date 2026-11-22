import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StopCallDtmfRecognition } from "./StopCallDtmfRecognition.ts";

/**
 * Implementation of {@link StopCallDtmfRecognition} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StopCallDtmfRecognition
 */
export const StopCallDtmfRecognitionHttp = Layer.effect(
  StopCallDtmfRecognition,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StopCallDtmfRecognition",
    operation: callAutomation.StopCallMediaContinuousDtmfRecognition,
    grant: CommunicationRole.Data,
  }),
);
