import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { FindSimilarFacesFromFaceList } from "./FindSimilarFacesFromFaceList.ts";

/**
 * Implementation of {@link FindSimilarFacesFromFaceList} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceFindSimilarRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.FindSimilarFacesFromFaceList
 */
export const FindSimilarFacesFromFaceListHttp = Layer.effect(
  FindSimilarFacesFromFaceList,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.FindSimilarFacesFromFaceList",
    operation: face.ListFaceRecognitionOperationsFindSimilarFromFace,
    grant: AIRole.FaceFindSimilar,
  }),
);
