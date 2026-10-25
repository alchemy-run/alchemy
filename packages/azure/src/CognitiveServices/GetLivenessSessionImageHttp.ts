import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetLivenessSessionImage } from "./GetLivenessSessionImage.ts";

/**
 * Implementation of {@link GetLivenessSessionImage} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAISessionImagesReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetLivenessSessionImage
 */
export const GetLivenessSessionImageHttp = Layer.effect(
  GetLivenessSessionImage,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetLivenessSessionImage",
    operation: face.GetLivenessSessionOperationSessionImage,
    grant: AIRole.SessionImagesRead,
  }),
);
