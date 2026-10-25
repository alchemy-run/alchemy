import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { IdentifyFacesFromDynamicPersonGroup } from "./IdentifyFacesFromDynamicPersonGroup.ts";

/**
 * Implementation of {@link IdentifyFacesFromDynamicPersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceIdentifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.IdentifyFacesFromDynamicPersonGroup
 */
export const IdentifyFacesFromDynamicPersonGroupHttp = Layer.effect(
  IdentifyFacesFromDynamicPersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.IdentifyFacesFromDynamicPersonGroup",
    operation: face.FaceRecognitionOperationsIdentifyFromDynamicPersonGroup,
    grant: AIRole.FaceIdentify,
  }),
);
