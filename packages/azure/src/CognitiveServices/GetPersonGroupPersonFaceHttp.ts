import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetPersonGroupPersonFace } from "./GetPersonGroupPersonFace.ts";

/**
 * Implementation of {@link GetPersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupFacesReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetPersonGroupPersonFace
 */
export const GetPersonGroupPersonFaceHttp = Layer.effect(
  GetPersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetPersonGroupPersonFace",
    operation: face.GetPersonGroupOperationPersonGroupPersonFace,
    grant: AIRole.PersonGroupFacesRead,
  }),
);
