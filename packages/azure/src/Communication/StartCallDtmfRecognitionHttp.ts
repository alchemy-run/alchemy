import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StartCallDtmfRecognition } from "./StartCallDtmfRecognition.ts";

/**
 * Implementation of {@link StartCallDtmfRecognition} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StartCallDtmfRecognition
 */
export const StartCallDtmfRecognitionHttp = Layer.effect(
  StartCallDtmfRecognition,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StartCallDtmfRecognition",
    operation: callAutomation.StartCallMediaContinuousDtmfRecognition,
    grant: CommunicationRole.Data,
  }),
);
