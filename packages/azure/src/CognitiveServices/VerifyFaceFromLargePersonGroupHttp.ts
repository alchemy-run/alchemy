import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { VerifyFaceFromLargePersonGroup } from "./VerifyFaceFromLargePersonGroup.ts";

/**
 * Implementation of {@link VerifyFaceFromLargePersonGroup} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceVerifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.VerifyFaceFromLargePersonGroup
 */
export const VerifyFaceFromLargePersonGroupHttp = Layer.effect(
  VerifyFaceFromLargePersonGroup,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.VerifyFaceFromLargePersonGroup",
    operation: face.VerifyFaceRecognitionOperationFromLargePersonGroup,
    grant: AIRole.FaceVerify,
  }),
);
