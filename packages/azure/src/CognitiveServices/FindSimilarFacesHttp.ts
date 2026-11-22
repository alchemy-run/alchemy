import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { FindSimilarFaces } from "./FindSimilarFaces.ts";

/**
 * Implementation of {@link FindSimilarFaces} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceFindSimilarRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.FindSimilarFaces
 */
export const FindSimilarFacesHttp = Layer.effect(
  FindSimilarFaces,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.FindSimilarFaces",
    operation: face.FaceRecognitionOperationsFindSimilar,
    grant: AIRole.FaceFindSimilar,
  }),
);
