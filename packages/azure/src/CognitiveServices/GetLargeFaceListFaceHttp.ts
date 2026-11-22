import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLargeFaceListFace } from "./GetLargeFaceListFace.ts";

/**
 * Implementation of {@link GetLargeFaceListFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListFacesReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLargeFaceListFace
 */
export const GetLargeFaceListFaceHttp = Layer.effect(
  GetLargeFaceListFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLargeFaceListFace",
    operation: face.FaceListOperationsGetLargeFaceListFace,
    grant: AIRole.LargeFaceListFacesRead,
  }),
);
