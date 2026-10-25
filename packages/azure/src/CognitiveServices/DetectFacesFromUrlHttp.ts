import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DetectFacesFromUrl } from "./DetectFacesFromUrl.ts";

/**
 * Implementation of {@link DetectFacesFromUrl} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceDetectRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DetectFacesFromUrl
 */
export const DetectFacesFromUrlHttp = Layer.effect(
  DetectFacesFromUrl,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DetectFacesFromUrl",
    operation: face.FaceDetectionOperationsDetectFromUrl,
    grant: AIRole.FaceDetect,
  }),
);
