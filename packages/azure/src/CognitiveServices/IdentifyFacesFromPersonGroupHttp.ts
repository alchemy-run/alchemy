import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { IdentifyFacesFromPersonGroup } from "./IdentifyFacesFromPersonGroup.ts";

/**
 * Implementation of {@link IdentifyFacesFromPersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceIdentifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.IdentifyFacesFromPersonGroup
 */
export const IdentifyFacesFromPersonGroupHttp = Layer.effect(
  IdentifyFacesFromPersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.IdentifyFacesFromPersonGroup",
    operation: face.FaceRecognitionOperationsIdentifyFromPersonGroup,
    grant: AIRole.FaceIdentify,
  }),
);
