import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { IdentifyFacesFromLargePersonGroup } from "./IdentifyFacesFromLargePersonGroup.ts";

/**
 * Implementation of {@link IdentifyFacesFromLargePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceIdentifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.IdentifyFacesFromLargePersonGroup
 */
export const IdentifyFacesFromLargePersonGroupHttp = Layer.effect(
  IdentifyFacesFromLargePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.IdentifyFacesFromLargePersonGroup",
    operation: face.FaceRecognitionOperationsIdentifyFromLargePersonGroup,
    grant: AIRole.FaceIdentify,
  }),
);
