import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { FindSimilarFacesFromLargeFaceList } from "./FindSimilarFacesFromLargeFaceList.ts";

/**
 * Implementation of {@link FindSimilarFacesFromLargeFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceFindSimilarRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.FindSimilarFacesFromLargeFaceList
 */
export const FindSimilarFacesFromLargeFaceListHttp = Layer.effect(
  FindSimilarFacesFromLargeFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.FindSimilarFacesFromLargeFaceList",
    operation: face.ListFaceRecognitionOperationsFindSimilarFromLargeFace,
    grant: AIRole.FaceFindSimilar,
  }),
);
