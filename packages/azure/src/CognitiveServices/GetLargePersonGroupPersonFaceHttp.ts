import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLargePersonGroupPersonFace } from "./GetLargePersonGroupPersonFace.ts";

/**
 * Implementation of {@link GetLargePersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupFacesReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLargePersonGroupPersonFace
 */
export const GetLargePersonGroupPersonFaceHttp = Layer.effect(
  GetLargePersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLargePersonGroupPersonFace",
    operation: face.GetPersonGroupOperationLargePersonGroupPersonFace,
    grant: AIRole.LargePersonGroupFacesRead,
  }),
);
