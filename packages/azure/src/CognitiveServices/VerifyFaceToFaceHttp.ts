import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { VerifyFaceToFace } from "./VerifyFaceToFace.ts";

/**
 * Implementation of {@link VerifyFaceToFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceVerifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.VerifyFaceToFace
 */
export const VerifyFaceToFaceHttp = Layer.effect(
  VerifyFaceToFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.VerifyFaceToFace",
    operation: face.VerifyFaceRecognitionOperationFaceToFace,
    grant: AIRole.FaceVerify,
  }),
);
