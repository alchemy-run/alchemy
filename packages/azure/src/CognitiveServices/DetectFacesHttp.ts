import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DetectFaces } from "./DetectFaces.ts";

/**
 * Implementation of {@link DetectFaces} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceDetectRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DetectFaces
 */
export const DetectFacesHttp = Layer.effect(
  DetectFaces,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DetectFaces",
    operation: face.FaceDetectionOperationsDetect,
    grant: AIRole.FaceDetect,
  }),
);
