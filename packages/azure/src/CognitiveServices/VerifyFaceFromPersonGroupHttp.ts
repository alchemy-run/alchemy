import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { VerifyFaceFromPersonGroup } from "./VerifyFaceFromPersonGroup.ts";

/**
 * Implementation of {@link VerifyFaceFromPersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceVerifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.VerifyFaceFromPersonGroup
 */
export const VerifyFaceFromPersonGroupHttp = Layer.effect(
  VerifyFaceFromPersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.VerifyFaceFromPersonGroup",
    operation: face.VerifyFaceRecognitionOperationFromPersonGroup,
    grant: AIRole.FaceVerify,
  }),
);
