import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DetectFacesFromSessionImage } from "./DetectFacesFromSessionImage.ts";

/**
 * Implementation of {@link DetectFacesFromSessionImage} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceDetectRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DetectFacesFromSessionImage
 */
export const DetectFacesFromSessionImageHttp = Layer.effect(
  DetectFacesFromSessionImage,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DetectFacesFromSessionImage",
    operation: face.FaceDetectionOperationsDetectFromSessionImageId,
    grant: AIRole.FaceDetect,
  }),
);
