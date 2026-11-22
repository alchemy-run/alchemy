import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { VerifyFaceFromPersonDirectory } from "./VerifyFaceFromPersonDirectory.ts";

/**
 * Implementation of {@link VerifyFaceFromPersonDirectory} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceVerifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.VerifyFaceFromPersonDirectory
 */
export const VerifyFaceFromPersonDirectoryHttp = Layer.effect(
  VerifyFaceFromPersonDirectory,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.VerifyFaceFromPersonDirectory",
    operation: face.VerifyFaceRecognitionOperationFromPersonDirectory,
    grant: AIRole.FaceVerify,
  }),
);
