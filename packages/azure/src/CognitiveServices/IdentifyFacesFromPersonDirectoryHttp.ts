import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { IdentifyFacesFromPersonDirectory } from "./IdentifyFacesFromPersonDirectory.ts";

/**
 * Implementation of {@link IdentifyFacesFromPersonDirectory} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceIdentifyRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.IdentifyFacesFromPersonDirectory
 */
export const IdentifyFacesFromPersonDirectoryHttp = Layer.effect(
  IdentifyFacesFromPersonDirectory,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.IdentifyFacesFromPersonDirectory",
    operation: face.FaceRecognitionOperationsIdentifyFromPersonDirectory,
    grant: AIRole.FaceIdentify,
  }),
);
